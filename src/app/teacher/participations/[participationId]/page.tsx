import { ClassroomWorkspace } from "@/components/platform/classroom-workspace";
export default async function Page({ params }: { params: Promise<{ participationId: string }> }) {
  return <ClassroomWorkspace role="teacher" participationId={(await params).participationId} />;
}
