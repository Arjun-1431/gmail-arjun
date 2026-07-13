const dotenv = require("dotenv");
const { google } = require("googleapis");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

dotenv.config();

const DATA_DIR = path.join(process.cwd(), "data");
const JOB_STORE_PATH = path.join(DATA_DIR, "job-followups.json");
const FIFTEEN_HOURS_MS = 15 * 60 * 60 * 1000;

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const INBOX_CATEGORY_LABELS = {
  primary: "CATEGORY_PERSONAL",
  promotions: "CATEGORY_PROMOTIONS",
  social: "CATEGORY_SOCIAL",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};

const READ_ONLY_FS_ERROR_CODES = new Set(["EROFS", "EACCES", "EPERM"]);

function getOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } =
    process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth env vars are not configured.");
  }

  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function getAuthedGmail(req) {
  if (!req.session.googleTokens) {
    const error = new Error("Gmail is not connected.");
    error.statusCode = 401;
    throw error;
  }

  const auth = getOAuthClient();
  auth.setCredentials(req.session.googleTokens);
  auth.on("tokens", (tokens) => {
    req.session.googleTokens = { ...req.session.googleTokens, ...tokens };
  });

  return google.gmail({ version: "v1", auth });
}

function getGmailFromTokens(tokens) {
  const auth = getOAuthClient();
  auth.setCredentials(tokens);
  return google.gmail({ version: "v1", auth });
}

function getHeader(headers = [], name) {
  const expectedName = name.toLowerCase();
  return (
    headers.find((header) => header.name.toLowerCase() === expectedName)?.value ||
    ""
  );
}

function decodeBase64Url(value = "") {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function findBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const body = findBody(part);
    if (body) return body;
  }
  return payload.body?.data ? decodeBase64Url(payload.body.data) : "";
}

function findAttachments(payload, attachments = []) {
  if (!payload) return attachments;
  if (payload.filename && payload.body?.attachmentId) {
    attachments.push({
      id: payload.body.attachmentId,
      filename: payload.filename,
      mimeType: payload.mimeType || "application/octet-stream",
      size: payload.body.size || 0,
    });
  }

  for (const part of payload.parts || []) {
    findAttachments(part, attachments);
  }

  return attachments;
}

function normalizeMessage(message) {
  const headers = message.payload?.headers || [];
  const labels = message.labelIds || [];
  const date = getHeader(headers, "Date");

  return {
    id: message.id,
    threadId: message.threadId,
    subject: getHeader(headers, "Subject") || "(No subject)",
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    snippet: message.snippet || "",
    date,
    internalDate: message.internalDate || null,
    sortTime: Number(message.internalDate || Date.parse(date) || 0),
    labels,
    unread: labels.includes("UNREAD"),
  };
}

function normalizeFullMessage(message) {
  const headers = message.payload?.headers || [];
  return {
    ...normalizeMessage(message),
    cc: getHeader(headers, "Cc"),
    bcc: getHeader(headers, "Bcc"),
    replyTo: getHeader(headers, "Reply-To"),
    messageId: getHeader(headers, "Message-ID"),
    references: getHeader(headers, "References"),
    body: findBody(message.payload),
    attachments: findAttachments(message.payload),
    internalDate: message.internalDate,
  };
}

function stripHtml(value = "") {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchQuery(query = {}) {
  const parts = [];
  if (query.subject) parts.push(`subject:(${query.subject})`);
  if (query.sender) parts.push(`from:(${query.sender})`);
  if (query.date) {
    const selected = new Date(`${query.date}T00:00:00.000Z`);
    selected.setUTCDate(selected.getUTCDate() + 1);
    const nextDay = selected.toISOString().slice(0, 10);
    parts.push(`after:${query.date} before:${nextDay}`);
  }
  if (query.q) parts.push(query.q);
  return parts.join(" ");
}

async function listMessages(req, labelIds) {
  const gmail = getAuthedGmail(req);
  const maxResults = Math.min(Number(req.query.limit || 20), 50);
  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds,
    maxResults,
    pageToken: req.query.pageToken,
    q: buildSearchQuery(req.query),
  });

  const messages = listResponse.data.messages || [];
  const hydrated = await Promise.all(
    messages.map(async ({ id }) => {
      const message = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "To", "Date"],
      });
      return normalizeMessage(message.data);
    })
  );

  const sorted = hydrated.sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0));

  return {
    emails: sorted,
    nextPageToken: listResponse.data.nextPageToken || null,
    resultSizeEstimate: listResponse.data.resultSizeEstimate || 0,
  };
}

function createRawEmail({ to, subject, body, cc, bcc, inReplyTo, references }) {
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${subject || ""}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    "Content-Type: text/html; charset=utf-8",
    "",
    body || "",
  ].filter(Boolean);

  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (error) {
    if (!READ_ONLY_FS_ERROR_CODES.has(error.code)) {
      throw error;
    }
  }
}

function readJobStore() {
  ensureDataDir();
  if (!fs.existsSync(JOB_STORE_PATH)) {
    return { accounts: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(JOB_STORE_PATH, "utf8"));
  } catch {
    return { accounts: {} };
  }
}

function writeJobStore(store) {
  ensureDataDir();
  try {
    fs.writeFileSync(JOB_STORE_PATH, JSON.stringify(store, null, 2));
  } catch (error) {
    if (READ_ONLY_FS_ERROR_CODES.has(error.code)) {
      console.warn("Job store is read-only in this runtime; skipping file write.");
      return false;
    }
    throw error;
  }
  return true;
}

function getAccount(store, emailAddress) {
  if (!store.accounts[emailAddress]) {
    store.accounts[emailAddress] = {
      automationEnabled: false,
      encryptedTokens: null,
      applications: {},
      importantInbox: {},
      jobReplies: {},
    };
  }
  if (!store.accounts[emailAddress].importantInbox) {
    store.accounts[emailAddress].importantInbox = {};
  }
  if (!store.accounts[emailAddress].jobReplies) {
    store.accounts[emailAddress].jobReplies = {};
  }
  return store.accounts[emailAddress];
}

function getEncryptionKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.SESSION_SECRET || "change-me-in-env")
    .digest();
}

function encryptTokens(tokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    value: encrypted.toString("base64"),
  };
}

function decryptTokens(payload) {
  if (!payload) return null;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.value, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

function extractEmailAddress(value = "") {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] || value).split(",")[0].trim().toLowerCase();
}

function looksLikeJobApplication(email) {
  const text = `${email.subject || ""} ${email.snippet || ""} ${stripHtml(
    email.body || ""
  )}`.toLowerCase();
  return /application|applying|resume|cv|web developer|developer position|job|hiring manager|position/.test(
    text
  );
}

function inferJobReplyStatus(email) {
  const text = `${email.subject || ""} ${email.snippet || ""} ${stripHtml(
    email.body || ""
  )}`.toLowerCase();

  if (/not selected|not shortlisted|unfortunately|regret|reject/.test(text)) {
    return { status: "rejected", reason: "The reply indicates rejection." };
  }
  if (/interview|scheduled|schedule|meeting|call|round/.test(text)) {
    return {
      status: "interview_requested",
      reason: "The reply includes interview scheduling or next-round details.",
    };
  }
  if (/selected|shortlisted|congratulations|pleased to inform/.test(text)) {
    return {
      status: /shortlisted/.test(text) ? "shortlisted" : "selected",
      reason: "The reply indicates selection or shortlisting.",
    };
  }
  if (/next steps|application update|thank you for your interest/.test(text)) {
    return { status: "replied", reason: "The recruiter replied to the application." };
  }
  return { status: "other", reason: "" };
}

async function callNvidiaJson(messages, fallback) {
  if (!process.env.NVIDIA_API_KEY) {
    const error = new Error("NVIDIA_API_KEY is not configured.");
    error.statusCode = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct",
        temperature: 0.1,
        max_tokens: 900,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(`NVIDIA API failed with status ${response.status}.`);
      error.statusCode = 502;
      throw error;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return fallback;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      console.warn("NVIDIA API request timed out, using fallback");
      return fallback;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function classifySentJobEmail(email) {
  const fallback = {
    isJobApplication: false,
    company: "",
    role: "",
    confidence: 0,
  };

  return callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Detect whether a sent email is a job application email.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: {
            isJobApplication: "boolean",
            company: "string",
            role: "string",
            confidence: "number 0-1",
          },
          subject: email.subject,
          to: email.to,
          snippet: email.snippet,
          body: stripHtml(email.body).slice(0, 2500),
        }),
      },
    ],
    fallback
  );
}

async function analyzeThreadOutcome(threadMessages, applicantEmail) {
  const replies = threadMessages.filter((message) => {
    const from = extractEmailAddress(message.from);
    return from && from !== applicantEmail.toLowerCase();
  });

  if (!replies.length) {
    return { status: "no_response", reason: "No recruiter reply found." };
  }

  return callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Analyze recruiter replies to a job application. Status must be one of replied, rejected, selected, interview_requested, no_response.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: {
            status: "replied|rejected|selected|interview_requested|no_response",
            reason: "short string",
          },
          replies: replies.map((message) => ({
            from: message.from,
            date: message.date,
            subject: message.subject,
            body: stripHtml(message.body || message.snippet).slice(0, 2000),
          })),
        }),
      },
    ],
    { status: "replied", reason: "Recruiter replied." }
  );
}

async function generateFollowUpEmail(application) {
  const fallbackBody = `<p>Hello,</p><p>I hope you are doing well. I wanted to follow up on my application for ${application.role || "the role"}. I remain interested in the opportunity and would be happy to discuss my fit for the position or schedule an interview at your convenience.</p><p>Thank you for your time.</p>`;

  const result = await callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Write a concise, polite job application follow-up email asking for an update and interview scheduling availability.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: { subject: "string", bodyHtml: "string" },
          company: application.company,
          role: application.role,
          originalSubject: application.subject,
          recipient: application.to,
        }),
      },
    ],
    {
      subject: `Follow up: ${application.subject}`,
      bodyHtml: fallbackBody,
    }
  );

  return {
    subject: result.subject || `Follow up: ${application.subject}`,
    bodyHtml: result.bodyHtml || fallbackBody,
  };
}

async function classifyImportantInboxEmail(email) {
  const fallback = {
    isImportant: false,
    category: "other",
    title: "",
    reason: "",
    confidence: 0,
  };

  return callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Classify whether this inbox email is personally important. Important categories are job_response, selection, offer_letter, interview, achievement, deadline, financial, urgent, other_important, other.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: {
            isImportant: "boolean",
            category:
              "job_response|selection|offer_letter|interview|achievement|deadline|financial|urgent|other_important|other",
            title: "short string",
            reason: "short English explanation",
            confidence: "number 0-1",
          },
          subject: email.subject,
          from: email.from,
          to: email.to,
          snippet: email.snippet,
          body: stripHtml(email.body).slice(0, 2600),
        }),
      },
    ],
    fallback
  );
}

async function classifyJobReplyEmail(email) {
  const fallback = {
    isJobRelatedReply: false,
    status: "other",
    company: "",
    role: "",
    interviewDate: "",
    reason: "",
    confidence: 0,
  };

  return callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Analyze if this inbox email is a reply/status update for a job application. Status must be selected, interview_requested, shortlisted, rejected, replied, or other.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: {
            isJobRelatedReply: "boolean",
            status:
              "selected|interview_requested|shortlisted|rejected|replied|other",
            company: "string",
            role: "string",
            interviewDate: "string if present",
            reason: "short English explanation",
            confidence: "number 0-1",
          },
          subject: email.subject,
          from: email.from,
          replyTo: email.replyTo,
          snippet: email.snippet,
          body: stripHtml(email.body).slice(0, 3000),
        }),
      },
    ],
    fallback
  );
}

async function generateJobReplyEmail(jobReply) {
  const fallbackBody = `<p>Hello,</p><p>Thank you for your email. I appreciate the update and I am interested in moving forward. Please let me know the next steps and a suitable time for the interview or discussion.</p><p>Best regards,<br/>Arjun Singh</p>`;

  const result = await callNvidiaJson(
    [
      {
        role: "system",
        content:
          "Return strict JSON only. Write a concise, professional reply to a recruiter/job email. Be polite, confident, and ask for next steps or interview schedule when relevant.",
      },
      {
        role: "user",
        content: JSON.stringify({
          expectedSchema: { subject: "string", bodyHtml: "string" },
          status: jobReply.status,
          company: jobReply.company,
          role: jobReply.role,
          interviewDate: jobReply.interviewDate,
          originalSubject: jobReply.subject,
          recruiterFrom: jobReply.from,
          reason: jobReply.reason,
        }),
      },
    ],
    {
      subject: jobReply.subject?.toLowerCase().startsWith("re:")
        ? jobReply.subject
        : `Re: ${jobReply.subject}`,
      bodyHtml: fallbackBody,
    }
  );

  return {
    subject:
      result.subject ||
      (jobReply.subject?.toLowerCase().startsWith("re:")
        ? jobReply.subject
        : `Re: ${jobReply.subject}`),
    bodyHtml: result.bodyHtml || fallbackBody,
  };
}

async function buildSentJobApplicationIndex(gmail, account, limit = 100) {
  const sentResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["SENT"],
    maxResults: Math.min(Number(limit || 100), 100),
    q: '("application" OR "applying" OR "resume" OR "cv" OR "job" OR "position" OR "web developer" OR "hiring manager")',
  });
  const threadIds = new Set();
  const recipientEmails = new Set();
  const applicationsByThread = {};

  for (const item of sentResponse.data.messages || []) {
    const sentMessage = await getFullMessage(gmail, item.id);
    const previous = account.applications[sentMessage.id] || {};
    let classification = {
      isJobApplication: Boolean(previous.id),
      company: previous.company || "",
      role: previous.role || "",
      confidence: previous.confidence || 0,
    };

    if (!classification.isJobApplication) {
      try {
        classification = await classifySentJobEmail(sentMessage);
      } catch {
        classification = {
          isJobApplication: looksLikeJobApplication(sentMessage),
          company: "",
          role: "",
          confidence: looksLikeJobApplication(sentMessage) ? 0.7 : 0,
        };
      }
    }

    const isJobApplication =
      classification.isJobApplication ||
      classification.confidence >= 0.55 ||
      looksLikeJobApplication(sentMessage);

    if (!isJobApplication) continue;

    const recipientEmail = extractEmailAddress(sentMessage.to);
    const application = {
      id: sentMessage.id,
      threadId: sentMessage.threadId,
      subject: sentMessage.subject,
      to: sentMessage.to,
      recipientEmail,
      date: sentMessage.date,
      company: classification.company || previous.company || "",
      role: classification.role || previous.role || "",
      confidence: Math.max(classification.confidence || 0, previous.confidence || 0),
      status: previous.status || "no_response",
      reason: previous.reason || "Waiting for recruiter response.",
      stopFollowUps: previous.stopFollowUps || false,
      lastAnalyzedAt: previous.lastAnalyzedAt || null,
      lastFollowUpAt: previous.lastFollowUpAt || null,
      followUpCount: previous.followUpCount || 0,
    };

    account.applications[sentMessage.id] = application;
    if (sentMessage.threadId) {
      threadIds.add(sentMessage.threadId);
      applicationsByThread[sentMessage.threadId] = application;
    }
    if (recipientEmail) recipientEmails.add(recipientEmail);
  }

  return { threadIds, recipientEmails, applicationsByThread };
}

async function analyzeJobReplies(req) {
  const gmail = getAuthedGmail(req);
  const profile = await gmail.users.getProfile({ userId: "me" });
  const store = readJobStore();
  const account = getAccount(store, profile.data.emailAddress);
  account.encryptedTokens = encryptTokens(req.session.googleTokens);
  const sentIndex = await buildSentJobApplicationIndex(
    gmail,
    account,
    req.query.sentLimit || 50
  );
  pruneUnlinkedJobReplies(account, sentIndex);
  const autoReply = req.query.autoReply === "true";

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults: Math.min(Number(req.query.limit || 50), 75),
    q:
      req.query.q ||
      '("selected" OR "shortlisted" OR "interview" OR "schedule" OR "congratulations" OR "next round" OR "next steps" OR "hiring" OR "application update" OR "offer")',
  });

  const messagesToProcess = listResponse.data.messages || [];
  
  // Parallelize email fetching
  const emails = await Promise.all(
    messagesToProcess.map(async (item) => {
      try {
        return await getFullMessage(gmail, item.id);
      } catch (error) {
        console.warn(`Failed to fetch email ${item.id}:`, error.message);
        return null;
      }
    })
  );

  // Filter emails and prepare for processing
  const emailsToClassify = emails.filter((email) => {
    if (!email) return false;
    const senderEmail = extractEmailAddress(email.from);
    return (
      sentIndex.threadIds.has(email.threadId) ||
      sentIndex.recipientEmails.has(senderEmail)
    );
  });

  // Parallelize classifications
  const classifications = await Promise.all(
    emailsToClassify.map(async (email) => {
      // Try to use existing classification
      const existing = account.jobReplies[email.id];
      if (existing && existing.analyzedAt) {
        return { email, classification: null, existing }; // null means use existing
      }

      try {
        const classification = await classifyJobReplyEmail(email);
        return { email, classification, existing };
      } catch (error) {
        console.warn(`Classification failed for ${email.id}:`, error.message);
        const inferred = inferJobReplyStatus(email);
        return {
          email,
          classification: {
            isJobRelatedReply: inferred.status !== "other",
            status: inferred.status,
            company: "",
            role: "",
            interviewDate: "",
            reason: inferred.reason,
            confidence: inferred.status === "other" ? 0 : 0.75,
          },
          existing,
        };
      }
    })
  );

  // Process results
  const jobRepliesToGenerate = [];

  for (const { email, classification, existing } of classifications) {
    const senderEmail = extractEmailAddress(email.from);
    const linkedApplication = sentIndex.applicationsByThread[email.threadId];

    // Use existing classification if available
    let finalClassification = classification;
    if (!finalClassification) {
      if (existing) {
        // Reuse existing
        if (
          autoReply &&
          !existing.replySentAt &&
          ["selected", "interview_requested", "shortlisted"].includes(existing.status)
        ) {
          jobRepliesToGenerate.push({ jobReply: existing, isExisting: true });
        }
        continue;
      } else {
        // Fallback
        const inferred = inferJobReplyStatus(email);
        finalClassification = {
          isJobRelatedReply: inferred.status !== "other",
          status: inferred.status,
          company: linkedApplication?.company || "",
          role: linkedApplication?.role || "",
          interviewDate: "",
          reason: inferred.reason,
          confidence: inferred.status === "other" ? 0 : 0.75,
        };
      }
    }

    // Apply inference as fallback
    const inferred = inferJobReplyStatus(email);
    if (
      inferred.status !== "other" &&
      (finalClassification.status === "other" || finalClassification.confidence < 0.55)
    ) {
      finalClassification = {
        ...finalClassification,
        isJobRelatedReply: true,
        status: inferred.status,
        reason: inferred.reason,
        confidence: Math.max(finalClassification.confidence || 0, 0.75),
      };
    }

    if (
      !finalClassification.isJobRelatedReply ||
      finalClassification.confidence < 0.55 ||
      finalClassification.status === "other"
    ) {
      continue;
    }

    const jobReply = {
      id: email.id,
      threadId: email.threadId,
      linkedApplicationId: linkedApplication?.id || "",
      subject: email.subject,
      from: email.from,
      replyTo: email.replyTo,
      messageId: email.messageId,
      references: email.references,
      date: email.date,
      sortTime: email.sortTime,
      snippet: email.snippet,
      status: finalClassification.status,
      company: finalClassification.company || linkedApplication?.company || "",
      role: finalClassification.role || linkedApplication?.role || "",
      interviewDate: finalClassification.interviewDate || "",
      reason: finalClassification.reason || "",
      confidence: finalClassification.confidence || 0,
      replySentAt: existing?.replySentAt || null,
      analyzedAt: new Date().toISOString(),
    };

    account.jobReplies[email.id] = jobReply;

    if (
      autoReply &&
      !jobReply.replySentAt &&
      ["selected", "interview_requested", "shortlisted"].includes(jobReply.status)
    ) {
      jobRepliesToGenerate.push({ jobReply, isExisting: false });
    }

    if (linkedApplication) {
      linkedApplication.status = jobReply.status;
      linkedApplication.reason = jobReply.reason;
      linkedApplication.stopFollowUps = [
        "rejected",
        "selected",
        "interview_requested",
        "shortlisted",
      ].includes(jobReply.status);
      linkedApplication.lastAnalyzedAt = new Date().toISOString();
    }
  }

  // Parallelize reply generation and sending
  if (jobRepliesToGenerate.length > 0) {
    const generatePromises = jobRepliesToGenerate.map(async ({ jobReply }) => {
      try {
        return await generateJobReplyEmail(jobReply);
      } catch (error) {
        console.warn(`Generation failed for ${jobReply.id}:`, error.message);
        return null;
      }
    });

    const generated = await Promise.all(generatePromises);
    const sendPromises = jobRepliesToGenerate
      .map((item, i) => ({ item, generated: generated[i] }))
      .filter(({ generated }) => generated)
      .map(async ({ item: { jobReply }, generated }) => {
        try {
          await gmail.users.messages.send({
            userId: "me",
            requestBody: {
              threadId: jobReply.threadId,
              raw: createRawEmail({
                to: jobReply.replyTo || jobReply.from,
                subject: generated.subject,
                body: generated.bodyHtml,
                inReplyTo: jobReply.messageId,
                references: [jobReply.references, jobReply.messageId]
                  .filter(Boolean)
                  .join(" "),
              }),
            },
          });
          jobReply.replySentAt = new Date().toISOString();
          jobReply.autoReplied = true;
        } catch (error) {
          console.warn(`Send failed for ${jobReply.id}:`, error.message);
        }
      });

    await Promise.all(sendPromises);
  }

  writeJobStore(store);
  return account;
}

function serializeJobReplies(account) {
  return Object.values(account.jobReplies || {}).sort(
    (a, b) =>
      (b.sortTime || Date.parse(b.date) || 0) -
      (a.sortTime || Date.parse(a.date) || 0)
  );
}

function pruneUnlinkedJobReplies(account, sentIndex) {
  for (const [id, reply] of Object.entries(account.jobReplies || {})) {
    const senderEmail = extractEmailAddress(reply.from);
    const isLinked =
      sentIndex.threadIds.has(reply.threadId) ||
      sentIndex.recipientEmails.has(senderEmail);
    if (!isLinked) {
      delete account.jobReplies[id];
    }
  }
}

async function analyzeImportantInbox(req) {
  const gmail = getAuthedGmail(req);
  const profile = await gmail.users.getProfile({ userId: "me" });
  const store = readJobStore();
  const account = getAccount(store, profile.data.emailAddress);
  account.encryptedTokens = encryptTokens(req.session.googleTokens);

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults: Math.min(Number(req.query.limit || 50), 75),
    q:
      req.query.q ||
      '("offer letter" OR "selected" OR "congratulations" OR "interview" OR "shortlisted" OR "achievement" OR "award" OR "urgent" OR "important" OR "deadline" OR "job" OR "application" OR "next steps")',
  });

  const messagesToProcess = listResponse.data.messages || [];
  const newEmails = messagesToProcess.filter((item) => !account.importantInbox[item.id]);
  
  if (newEmails.length === 0) {
    writeJobStore(store);
    return account;
  }

  // Parallelize email fetching
  const emails = await Promise.all(
    newEmails.map(async (item) => {
      try {
        return await getFullMessage(gmail, item.id);
      } catch (error) {
        console.warn(`Failed to fetch email ${item.id}:`, error.message);
        return null;
      }
    })
  );

  // Parallelize classifications
  const classifications = await Promise.all(
    emails.map(async (email) => {
      if (!email) return { email: null, classification: null };
      try {
        const classification = await classifyImportantInboxEmail(email);
        return { email, classification };
      } catch (error) {
        console.warn(`Classification failed for ${email.id}:`, error.message);
        return {
          email,
          classification: {
            isImportant: false,
            category: "other",
            title: "",
            reason: "",
            confidence: 0,
          },
        };
      }
    })
  );

  // Process results
  for (const { email, classification } of classifications) {
    if (!email || !classification || !classification.isImportant || classification.confidence < 0.55) {
      continue;
    }

    account.importantInbox[email.id] = {
      id: email.id,
      threadId: email.threadId,
      subject: email.subject,
      from: email.from,
      to: email.to,
      snippet: email.snippet,
      date: email.date,
      internalDate: email.internalDate,
      sortTime: email.sortTime,
      unread: email.unread,
      category: classification.category || "other_important",
      title: classification.title || email.subject,
      reason: classification.reason || "",
      confidence: classification.confidence || 0,
      analyzedAt: new Date().toISOString(),
    };
  }

  writeJobStore(store);
  return account;
}

function serializeImportantInbox(account) {
  return Object.values(account.importantInbox || {}).sort(
    (a, b) =>
      (b.sortTime || Date.parse(b.date) || 0) -
      (a.sortTime || Date.parse(a.date) || 0)
  );
}

async function getFullMessage(gmail, id) {
  const response = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  return normalizeFullMessage(response.data);
}

async function getThreadMessages(gmail, threadId) {
  const response = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  return (response.data.messages || []).map(normalizeFullMessage);
}

async function analyzeSentJobApplications(req) {
  const gmail = getAuthedGmail(req);
  const profile = await gmail.users.getProfile({ userId: "me" });
  const applicantEmail = profile.data.emailAddress;
  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["SENT"],
    maxResults: Math.min(Number(req.query.limit || 25), 50),
    q:
      req.query.q ||
      '("applied" OR "application" OR "resume" OR "cv" OR "job" OR "position" OR "interview")',
  });

  const store = readJobStore();
  const account = getAccount(store, applicantEmail);
  account.encryptedTokens = encryptTokens(req.session.googleTokens);

  const messagesToProcess = listResponse.data.messages || [];

  // Parallelize email fetching
  const sentMessages = await Promise.all(
    messagesToProcess.map(async (item) => {
      try {
        return await getFullMessage(gmail, item.id);
      } catch (error) {
        console.warn(`Failed to fetch email ${item.id}:`, error.message);
        return null;
      }
    })
  );

  const validMessages = sentMessages.filter((msg) => msg !== null);

  // Parallelize classifications
  const classifications = await Promise.all(
    validMessages.map(async (sentMessage) => {
      const existing = account.applications[sentMessage.id];
      if (existing) {
        return { sentMessage, classification: existing };
      }

      try {
        const classification = await classifySentJobEmail(sentMessage);
        return { sentMessage, classification };
      } catch (error) {
        console.warn(`Classification failed for ${sentMessage.id}:`, error.message);
        return {
          sentMessage,
          classification: {
            isJobApplication: looksLikeJobApplication(sentMessage),
            company: "",
            role: "",
            confidence: looksLikeJobApplication(sentMessage) ? 0.7 : 0,
          },
        };
      }
    })
  );

  // Filter and prepare for thread analysis
  const toAnalyze = classifications.filter(({ classification }) => {
    return classification.isJobApplication && classification.confidence >= 0.55;
  });

  // Parallelize thread fetching and analysis
  const outcomes = await Promise.all(
    toAnalyze.map(async ({ sentMessage, classification }) => {
      try {
        const threadMessages = await getThreadMessages(gmail, sentMessage.threadId);
        const outcome = await analyzeThreadOutcome(threadMessages, applicantEmail);
        return { sentMessage, classification, outcome };
      } catch (error) {
        console.warn(`Thread analysis failed for ${sentMessage.id}:`, error.message);
        return {
          sentMessage,
          classification,
          outcome: { status: "no_response", reason: "Analysis failed." },
        };
      }
    })
  );

  // Process results
  for (const { sentMessage, classification, outcome } of outcomes) {
    const now = new Date().toISOString();
    const previous = account.applications[sentMessage.id] || {};
    const stopFollowUps = ["rejected", "selected", "interview_requested"].includes(
      outcome.status
    );

    account.applications[sentMessage.id] = {
      id: sentMessage.id,
      threadId: sentMessage.threadId,
      subject: sentMessage.subject,
      to: sentMessage.to,
      recipientEmail: extractEmailAddress(sentMessage.to),
      date: sentMessage.date,
      company: classification.company || previous.company || "",
      role: classification.role || previous.role || "",
      confidence: classification.confidence,
      status: outcome.status,
      reason: outcome.reason,
      stopFollowUps,
      lastAnalyzedAt: now,
      lastFollowUpAt: previous.lastFollowUpAt || null,
      followUpCount: previous.followUpCount || 0,
    };
  }

  writeJobStore(store);
  return account;
}

function getDueApplications(account) {
  const now = Date.now();
  return Object.values(account.applications).filter((application) => {
    if (application.stopFollowUps) return false;
    if (application.status !== "no_response") return false;
    const last = application.lastFollowUpAt
      ? new Date(application.lastFollowUpAt).getTime()
      : new Date(application.date || 0).getTime();
    return Number.isFinite(last) && now - last >= FIFTEEN_HOURS_MS;
  });
}

async function sendFollowUp(gmail, application) {
  const generated = await generateFollowUpEmail(application);
  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: createRawEmail({
        to: application.to,
        subject: generated.subject,
        body: generated.bodyHtml,
      }),
    },
  });
  return sent.data;
}

async function runDueFollowUps() {
  const store = readJobStore();
  let changed = false;

  for (const [emailAddress, account] of Object.entries(store.accounts)) {
    if (!account.automationEnabled || !account.encryptedTokens) continue;
    const tokens = decryptTokens(account.encryptedTokens);
    const gmail = getGmailFromTokens(tokens);
    for (const application of getDueApplications(account)) {
      try {
        await sendFollowUp(gmail, application);
        application.lastFollowUpAt = new Date().toISOString();
        application.followUpCount = (application.followUpCount || 0) + 1;
        application.reason = "Follow-up sent automatically.";
        changed = true;
        console.log(`Follow-up sent to ${application.recipientEmail} for ${emailAddress}`);
      } catch (error) {
        application.reason = `Follow-up failed: ${error.message}`;
        changed = true;
      }
    }
  }

  if (changed) writeJobStore(store);
}

async function labelCount(gmail, labelId) {
  const response = await gmail.users.labels.get({ userId: "me", id: labelId });
  return {
    total: response.data.messagesTotal || 0,
    unread: response.data.messagesUnread || 0,
  };
}

module.exports = {
  GMAIL_SCOPES,
  INBOX_CATEGORY_LABELS,
  getOAuthClient,
  getAuthedGmail,
  getGmailFromTokens,
  normalizeMessage,
  normalizeFullMessage,
  listMessages,
  createRawEmail,
  readJobStore,
  writeJobStore,
  getAccount,
  encryptTokens,
  decryptTokens,
  extractEmailAddress,
  generateJobReplyEmail,
  analyzeJobReplies,
  serializeJobReplies,
  analyzeImportantInbox,
  serializeImportantInbox,
  getFullMessage,
  getThreadMessages,
  analyzeSentJobApplications,
  getDueApplications,
  sendFollowUp,
  runDueFollowUps,
  labelCount,
};
