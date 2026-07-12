"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, getErrorMessage } from "@/lib/api";

function statusTone(status) {
  if (["selected", "interview_requested", "shortlisted"].includes(status)) {
    return "bg-emerald-50 text-emerald-700";
  }
  if (status === "rejected") return "bg-red-50 text-red-700";
  return "bg-zinc-100 text-zinc-700";
}

export default function JobRepliesPage() {
  const [replies, setReplies] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [autoReplying, setAutoReplying] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await api.get("/api/jobs/replies");
      setReplies(response.data.replies || []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Sync stored job reply analysis from the Express API on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function analyzeReplies(autoReply = false) {
    if (autoReply) {
      setAutoReplying(true);
    } else {
      setAnalyzing(true);
    }
    setError("");
    try {
      const response = await api.post(
        `/api/jobs/replies/analyze?limit=50&sentLimit=50&autoReply=${autoReply}`
      );
      setReplies(response.data.replies || []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setAnalyzing(false);
      setAutoReplying(false);
    }
  }

  async function generateDraft(id) {
    setBusyId(id);
    setError("");
    try {
      const response = await api.post(`/api/jobs/replies/${id}/generate`);
      setDrafts((current) => ({ ...current, [id]: response.data }));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId("");
    }
  }

  async function sendReply(id) {
    const draft = drafts[id];
    if (!draft?.subject || !draft?.bodyHtml) {
      await generateDraft(id);
      return;
    }

    setBusyId(id);
    setError("");
    try {
      await api.post(`/api/jobs/replies/${id}/send`, draft);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId("");
    }
  }

  function updateDraft(id, field, value) {
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], [field]: value },
    }));
  }

  const highlighted = replies.filter((reply) =>
    ["selected", "interview_requested", "shortlisted"].includes(reply.status)
  );

  return (
    <AppShell>
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Job Replies</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Replies from recipients you applied to will appear here when they mention selection, shortlisting, or interviews.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => analyzeReplies(false)}
            disabled={analyzing || autoReplying}
            className="w-fit rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {analyzing ? "Analyzing..." : "Analyze Job Replies"}
          </button>
          <button
            type="button"
            onClick={() => analyzeReplies(true)}
            disabled={analyzing || autoReplying}
            className="w-fit rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {autoReplying ? "Replying..." : "Analyze & Auto Reply"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <div className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="text-sm text-zinc-500">Selection / Interview</p>
          <p className="mt-2 text-2xl font-semibold">{highlighted.length}</p>
        </div>
        <div className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="text-sm text-zinc-500">All Job Replies</p>
          <p className="mt-2 text-2xl font-semibold">{replies.length}</p>
        </div>
        <div className="rounded-md border border-zinc-200 bg-white p-4">
          <p className="text-sm text-zinc-500">Replies Sent</p>
          <p className="mt-2 text-2xl font-semibold">
            {replies.filter((reply) => reply.replySentAt).length}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {loading && (
          <div className="rounded-md border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            Loading...
          </div>
        )}
        {!loading && replies.length === 0 && (
          <div className="rounded-md border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            No job replies found yet. Click Analyze Job Replies. Only replies linked to your sent job application emails are shown.
          </div>
        )}
        {replies.map((reply) => {
          const draft = drafts[reply.id];
          return (
            <section
              key={reply.id}
              className="rounded-md border border-zinc-200 bg-white p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <Link
                    href={`/email/${reply.id}`}
                    className="text-lg font-semibold text-zinc-950 hover:text-red-700"
                  >
                    {reply.subject}
                  </Link>
                  <p className="mt-1 truncate text-sm text-zinc-500">
                    {reply.from}
                  </p>
                  <p className="mt-2 text-sm text-zinc-600">{reply.reason}</p>
                  {reply.interviewDate && (
                    <p className="mt-1 text-sm font-medium text-zinc-950">
                      Interview: {reply.interviewDate}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <span
                    className={`rounded-md px-2 py-1 text-xs font-medium ${statusTone(
                      reply.status
                    )}`}
                  >
                    {reply.status}
                  </span>
                  {reply.replySentAt && (
                    <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                      replied
                    </span>
                  )}
                  {reply.autoReplied && (
                    <span className="rounded-md bg-purple-50 px-2 py-1 text-xs font-medium text-purple-700">
                      auto replied
                    </span>
                  )}
                </div>
              </div>

              {draft && (
                <div className="mt-4 space-y-2">
                  <input
                    value={draft.subject || ""}
                    onChange={(event) =>
                      updateDraft(reply.id, "subject", event.target.value)
                    }
                    className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-red-400"
                  />
                  <textarea
                    value={draft.bodyHtml || ""}
                    onChange={(event) =>
                      updateDraft(reply.id, "bodyHtml", event.target.value)
                    }
                    rows={7}
                    className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-red-400"
                  />
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => generateDraft(reply.id)}
                  disabled={busyId === reply.id}
                  className="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busyId === reply.id ? "Working..." : "Generate Reply"}
                </button>
                <button
                  type="button"
                  onClick={() => sendReply(reply.id)}
                  disabled={busyId === reply.id || reply.replySentAt}
                  className="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reply.replySentAt ? "Reply Sent" : "Send Reply"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
