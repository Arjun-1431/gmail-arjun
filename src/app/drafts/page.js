import MailboxPage from "@/components/MailboxPage";

export default function DraftsPage() {
  return <MailboxPage title="Drafts" endpoint="/api/gmail/drafts" />;
}
