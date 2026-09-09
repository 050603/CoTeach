import Link from "next/link";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";
import { LearningArt } from "@/components/platform/learning-art";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { authenticateRequest } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import CompatibleWorkspace from "./compatible-workspace";
import TeachSetupWorkspace from "./setup-workspace";
import { decodePblTemplate } from "@/lib/platform/pbl-template";
import { prisma } from "@/lib/db/client";

/** Keep bookmarked V1 setup URLs on the V2 offering / published-template workflow. */
export default async function TeachingSetupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ enter?: string }> }) {
  const { id } = await params;
  const auth = await authenticateRequest(new Request("http://localhost/teacher/setup", { headers: await headers() }), "teacher");
  if ("response" in auth || !await canAccessLegacyCourse(auth.claims, id)) notFound();
  const instance = await prisma.classroomInstance.findUnique({ where: { id }, select: { status: true, activityId: true, templateVersionId: true, templateVersion: { select: { templateId: true, snapshot: true } }, activity: { select: { title: true, chapter: { select: { offeringId: true, offering: { select: { invitations: { where: { status: "ACTIVE" }, take: 1, select: { code: true } } } } } } } } } });
  if (instance) {
    if (!decodePblTemplate(instance.templateVersion.snapshot)) return <CompatibleWorkspace id={id} title={instance.activity.title} userName={auth.claims.role === "teacher" ? auth.claims.displayName : "教师"} offeringId={instance.activity.chapter.offeringId} activityId={instance.activityId} templateVersionId={instance.templateVersionId} status={instance.status} snapshot={instance.templateVersion.snapshot} inviteCode={instance.activity.chapter.offering.invitations[0]?.code} />;
    if ((await searchParams).enter === "1" && instance.status.toUpperCase() === "TEACHING") redirect(`/teacher/teach/${id}/classroom`);
    return <TeachSetupWorkspace activityId={instance.activityId} offeringId={instance.activity.chapter.offeringId} templateVersionId={instance.templateVersionId} templateId={instance.templateVersion.templateId} />;
  }
  const template = await prisma.classroomTemplate.findUnique({ where: { id }, select: { title: true, versions: { where: { status: "PUBLISHED" }, select: { id: true }, take: 1 } } });
  if (!template) notFound();
  const offerings = await prisma.courseOffering.findMany({ where: { teachers: { some: { userId: auth.claims.sub } }, status: "OPEN" }, select: { id: true, name: true }, orderBy: { updatedAt: "desc" } });
  return <div className="pbl-platform-theme"><TeacherPlatformPage><TeacherPlatformHeader active="templates" backHref="/teacher/templates" backLabel="返回课程库" /><div className="pbl-workspace-content"><div className="mx-auto max-w-4xl space-y-6">
    <header className="pbl-page-heading"><LearningArt /><div><p className="text-xs tracking-widest text-[var(--pbl-teacher)]">从课程设计到课堂实践</p><h1 className="mt-3 font-semibold">为《{template.title}》安排课堂</h1></div></header><section className="pbl-content-card space-y-6 p-8 text-sm leading-7">
    {template.versions.length ? <>
      <p>选择教学班，在课堂活动中选用这份教案的已发布版本。学生沿用教学班邀请码加入，再次授课会创建新的场次并保留历史记录。</p>
      <div className="grid gap-3">{offerings.map(offering => <Link className="flex min-h-14 items-center rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)] px-5 py-3 font-medium text-[var(--pbl-teacher)]" href={`/teacher/classes/${offering.id}`} key={offering.id}>{offering.name}</Link>)}</div>
      <Link className="inline-block underline" href="/teacher/classes">管理或创建教学班</Link>
    </> : <>
      <p>请先完成备课并发布教案，再到教学班安排课堂。</p>
      <Link className="inline-block underline" href={`/teacher/prepare/${id}/verify`}>继续备课</Link>
    </>}
  </section></div></div></TeacherPlatformPage></div>;
}
