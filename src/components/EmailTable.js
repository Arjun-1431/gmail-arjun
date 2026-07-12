"use client";

import Link from "next/link";

export default function EmailTable({ emails, loading, onDelete, onMarkRead }) {
  if (loading) {
    return (
      <div className="rounded-md border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
        Loading emails...
      </div>
    );
  }

  if (!emails.length) {
    return (
      <div className="rounded-md border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
        No emails found.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">From</th>
              <th className="px-4 py-3">To</th>
              <th className="px-4 py-3">Labels</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {emails.map((email) => (
              <tr
                key={email.id}
                className={email.unread ? "bg-red-50/40" : "bg-white"}
              >
                <td className="max-w-xs px-4 py-3">
                  <Link
                    href={`/email/${email.id}`}
                    className="block truncate font-medium text-zinc-950 hover:text-red-700"
                  >
                    {email.subject}
                  </Link>
                  <p className="mt-1 truncate text-xs text-zinc-500">
                    {email.snippet}
                  </p>
                </td>
                <td className="max-w-[180px] truncate px-4 py-3 text-zinc-700">
                  {email.from}
                </td>
                <td className="max-w-[180px] truncate px-4 py-3 text-zinc-700">
                  {email.to}
                </td>
                <td className="px-4 py-3 text-xs text-zinc-500">
                  {email.labels?.slice(0, 3).join(", ")}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-zinc-500">
                  {email.date ? new Date(email.date).toLocaleDateString() : ""}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  {email.unread && (
                    <button
                      type="button"
                      onClick={() => onMarkRead(email.id)}
                      className="mr-2 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                    >
                      Read
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDelete(email.id)}
                    className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
