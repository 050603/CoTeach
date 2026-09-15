export const PUBLIC_DISCUSSION_EVENT = "openpbl:public-discussion";

export function emitPublicDiscussionUpdate(courseId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PUBLIC_DISCUSSION_EVENT, { detail: { courseId } }));
}

export function subscribePublicDiscussionUpdates(
  courseId: string,
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ courseId?: string }>).detail;
    if (detail?.courseId === courseId) listener();
  };
  window.addEventListener(PUBLIC_DISCUSSION_EVENT, handler);
  return () => window.removeEventListener(PUBLIC_DISCUSSION_EVENT, handler);
}
