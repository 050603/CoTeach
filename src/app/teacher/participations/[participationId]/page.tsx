import { ClassroomWorkspace } from "@/components/platform/classroom-workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ participationId: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const returnTo = (await searchParams).returnTo;
  const returnHref = returnTo?.startsWith("/teacher/classes/") ? returnTo : undefined;
  return <ClassroomWorkspace role="teacher" participationId={(await params).participationId} returnHref={returnHref} />;
}
