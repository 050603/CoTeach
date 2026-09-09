import { redirect } from "next/navigation";

// Chapter and activity access controls now live alongside the course directory.
export default async function AccessSettingsPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { offeringId } = await params;
  redirect(`/teacher/classes/${encodeURIComponent(offeringId)}`);
}
