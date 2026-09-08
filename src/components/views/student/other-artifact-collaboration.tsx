"use client";

import { DocumentAiCollaboration } from "./document-ai-collaboration";

/** New-system external-artifact variant of the document collaboration page. */
export function OtherArtifactCollaboration({ courseId }: { courseId: string }) {
  return (
    <DocumentAiCollaboration
      courseId={courseId}
      workspaceKind="external-artifact"
    />
  );
}
