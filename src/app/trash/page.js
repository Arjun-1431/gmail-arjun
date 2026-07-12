import MailboxPage from "@/components/MailboxPage";

export default function TrashPage() {
  return <MailboxPage title="Trash" endpoint="/api/gmail/trash" />;
}
