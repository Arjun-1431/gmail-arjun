import MailboxPage from "@/components/MailboxPage";

export default function SpamPage() {
  return <MailboxPage title="Spam" endpoint="/api/gmail/spam" />;
}
