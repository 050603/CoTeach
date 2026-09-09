type ClassroomEntryInstance = { id: string; status: string };

/** Only published versions can be used by the create-instance endpoint. */
export function publishedClassroomVersion<T extends { status: string; version: number }>(versions?: T[]) {
  return versions?.filter((version) => version.status.toLowerCase() === "published")
    .sort((a, b) => b.version - a.version)[0];
}

export function teacherClassroomEntry(instance: ClassroomEntryInstance, snapshotKind?: string) {
  const id = encodeURIComponent(instance.id);
  if (instance.status.toLowerCase() === "finished") {
    return { label: "查看课堂记录", href: `/teacher/classrooms/${id}` };
  }
  const teaching = instance.status.toLowerCase() === "teaching";
  // The setup route resolves the saved snapshot and redirects compatibility formats.
  return { label: teaching ? "继续授课" : "进入课堂", href: `/teacher/teach/${id}/${teaching && snapshotKind === "pbl-course" ? "classroom" : teaching ? "setup?enter=1" : "setup"}` };
}

export function studentClassroomHref(instanceId: string, participationId: string, snapshotKind?: string, status?: string) {
  return snapshotKind === "pbl-course" && status?.toLowerCase() !== "finished" ? `/student/classroom/${encodeURIComponent(instanceId)}` : `/student/participations/${encodeURIComponent(participationId)}`;
}
