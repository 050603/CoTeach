import { authorizeTemplateRequest } from '@/lib/platform/template-access';
import { getCourse } from '@/lib/session/server-store';
import { readClassroom, type PersistedClassroomData } from '@openmaic/lib/server/classroom-storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DownloadableClassroom = {
  kind: 'main' | 'teacher' | 'adaptive';
  label: string;
  classroom: PersistedClassroomData;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await context.params;
  const requestedBy = await authorizeTemplateRequest(request, courseId);
  if (requestedBy instanceof Response) return requestedBy;

  const course = await getCourse(courseId);
  if (!course) return Response.json({ error: '课程不存在' }, { status: 404 });

  const requestedClassrooms = [
    {
      id: course.aiLearningClassroomId || course.content._openmaicClassroomId,
      kind: 'main' as const,
      label: '学生 AI 课堂',
    },
    {
      id: course.content.teacherClassroomId,
      kind: 'teacher' as const,
      label: '教师授课资源',
    },
    ...(course.content.adaptiveLearningPlan?.branches ?? [])
      .filter((branch) => branch.enabled !== false && branch.preparedResource?.classroomId)
      .map((branch) => ({
        id: branch.preparedResource?.classroomId,
        kind: 'adaptive' as const,
        label: `个性化资源-${branch.title}`,
      })),
  ].filter((item): item is typeof item & { id: string } => Boolean(item.id));

  const seen = new Set<string>();
  const classrooms: DownloadableClassroom[] = [];
  for (const item of requestedClassrooms) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const classroom = await readClassroom(item.id);
    if (classroom) classrooms.push({ kind: item.kind, label: item.label, classroom });
  }

  if (classrooms.length === 0) {
    return Response.json({ error: '课程资源尚未生成' }, { status: 404 });
  }

  const resourcePackage = course.content.resourcePackage;
  const packageFiles = resourcePackage
    ? [
        resourcePackage.source,
        ...Object.values(resourcePackage.documents),
        resourcePackage.classroomPresentation,
      ].filter((file): file is NonNullable<typeof file> => Boolean(file))
    : [];
  const sourceFiles = [
    ...packageFiles.map((file) => ({ fileName: file.fileName, url: file.url })),
    ...(course.resources ?? [])
      .filter((resource) => resource.url)
      .map((resource) => ({ fileName: resource.title, url: resource.url as string })),
  ].filter((file, index, files) => files.findIndex((candidate) => candidate.url === file.url) === index);

  return Response.json({
    schemaVersion: 1,
    course: {
      id: course.id,
      name: course.name,
      subject: course.subject,
      grade: course.grade,
      updatedAt: course.updatedAt,
    },
    classrooms,
    sourceFiles,
  }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
