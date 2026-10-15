/**
 * Minimal additive bridge so the editor surface (chrome side) can drive the
 * renderer's ProseMirror commands without the renderer importing chrome or the
 * surface importing renderer internals. The renderer registers a runner while
 * an element is being edited; the property bar calls it. PR1-shaped: the
 * playback/uncontrolled path never registers (editable=false), so behavior
 * there is unchanged.
 */
export interface TextCommandPayload {
  command:
    | 'bold'
    | 'em'
    | 'underline'
    | 'fontname'
    | 'fontsize'
    | 'forecolor'
    | 'align-left'
    | 'align-center'
    | 'align-right'
    | 'bulletList';
  value?: string;
}

type Runner = (payload: TextCommandPayload) => void;

const runners = new Map<string, { run: Runner; focus?: () => void }>();

export function registerActiveTextEditor(elementId: string, run: Runner, focus?: () => void): () => void {
  const editor = { run, focus };
  runners.set(elementId, editor);
  return () => {
    if (runners.get(elementId) === editor) runners.delete(elementId);
  };
}

export function hasActiveTextEditor(elementId: string): boolean {
  return runners.has(elementId);
}

export function runActiveTextCommand(elementId: string, payload: TextCommandPayload): void {
  runners.get(elementId)?.run(payload);
}

export function focusActiveTextEditor(elementId: string): void {
  runners.get(elementId)?.focus?.();
}
