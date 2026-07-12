import MailboxPage from "@/components/MailboxPage";

export default function SentPage() {
  return <MailboxPage title="Sent" endpoint="/api/gmail/sent" />;
}
