import MailboxPage from "@/components/MailboxPage";

export default function InboxPage() {
  return <MailboxPage title="Inbox" endpoint="/api/gmail/inbox" />;
}
