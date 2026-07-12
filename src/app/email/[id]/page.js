"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import { api, getErrorMessage } from "@/lib/api";

function formatBytes(size = 0) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function EmailDetailPage() {
  const { id } = useParams();
  const [email, setEmail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await api.get(`/api/gmail/message/${id}`);
        setEmail(response.data);
        if (response.data.unread) {
          await api.patch(`/api/gmail/read/${id}`);
        }
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }

    if (id) load();
  }, [id]);

  return (
    <AppShell>
      {loading && (
        <div className="rounded-md border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
          Loading email...
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {email && (
        <article className="rounded-md border border-zinc-200 bg-white">
          <header className="border-b border-zinc-200 p-5">
            <h1 className="text-xl font-semibold">{email.subject}</h1>
            <div className="mt-3 space-y-1 text-sm text-zinc-600">
              <p>
                <span className="font-medium text-zinc-950">From:</span>{" "}
                {email.from}
              </p>
              <p>
                <span className="font-medium text-zinc-950">To:</span>{" "}
                {email.to}
              </p>
              {email.cc && (
                <p>
                  <span className="font-medium text-zinc-950">Cc:</span>{" "}
                  {email.cc}
                </p>
              )}
              <p>
                <span className="font-medium text-zinc-950">Date:</span>{" "}
                {email.date}
              </p>
              <p>
                <span className="font-medium text-zinc-950">Thread:</span>{" "}
                {email.threadId}
              </p>
            </div>
          </header>
          <div
            className="prose max-w-none p-5 text-sm leading-6 text-zinc-800"
            dangerouslySetInnerHTML={{ __html: email.body || email.snippet }}
          />
          {email.attachments?.length > 0 && (
            <section className="border-t border-zinc-200 p-5">
              <h2 className="text-sm font-semibold text-zinc-950">
                Attachments
              </h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {email.attachments.map((attachment) => {
                  const query = new URLSearchParams({
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                  });
                  return (
                    <a
                      key={attachment.id}
                      href={`/api/gmail/message/${email.id}/attachment/${attachment.id}?${query.toString()}`}
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm hover:bg-white"
                    >
                      <span className="block truncate font-medium text-zinc-950">
                        {attachment.filename}
                      </span>
                      <span className="mt-1 block text-xs text-zinc-500">
                        {attachment.mimeType}
                        {attachment.size ? ` • ${formatBytes(attachment.size)}` : ""}
                      </span>
                    </a>
                  );
                })}
              </div>
            </section>
          )}
        </article>
      )}
    </AppShell>
  );
}
