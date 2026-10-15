import { isPPTElementType, type PPTAnimation, type PPTElement } from '@openmaic/dsl';
import { useSlideEditSession } from '@openmaic/components/edit/surfaces/slide/slide-edit-session';
import { useCanvasStore } from '@openmaic/lib/store/canvas';
import { useStageStore } from '@openmaic/lib/store/stage';
import { createElementId } from './element-id';

export const SLIDE_CLIPBOARD_MIME = 'application/x-coteach-slide-elements';

interface SlideClipboard {
  format: 'coteach-slide-elements';
  version: 1;
  sourceSceneId: string;
  elements: PPTElement[];
  animations: PPTAnimation[];
}

// Also works on HTTP classroom hosts where navigator.clipboard is unavailable.
// Keep the snapshot independent of both the selection and the source page.
let localClipboard: string | null = null;
let lastPaste: { text: string; sceneId: string; count: number } | null = null;

function currentSession() {
  const session = useSlideEditSession.getState();
  const stage = useStageStore.getState();
  if (stage.mode !== 'edit' || !session.history || session.sceneId !== stage.currentSceneId) {
    return null;
  }
  const scene = stage.scenes.find((item) => item.id === session.sceneId);
  return scene?.content.type === 'slide' ? session : null;
}

function parseClipboard(text: string): SlideClipboard | null {
  try {
    const value = JSON.parse(text) as SlideClipboard;
    if (!value || value.format !== 'coteach-slide-elements' || value.version !== 1
      || typeof value.sourceSceneId !== 'string'
      || !Array.isArray(value.elements) || !value.elements.length
      || !Array.isArray(value.animations)) return null;
    const ids = new Set<string>();
    for (const element of value.elements) {
      if (!element || typeof element.id !== 'string' || !element.id || ids.has(element.id)
        || !isPPTElementType(element.type)
        || ![element.left, element.top, element.width].every(Number.isFinite)
        || (element.type !== 'line' && ![element.height, element.rotate].every(Number.isFinite))) {
        return null;
      }
      ids.add(element.id);
    }
    if (value.animations.some((animation) => !animation || !ids.has(animation.elId)
      || typeof animation.id !== 'string' || typeof animation.effect !== 'string'
      || !Number.isFinite(animation.duration))) return null;
    return value;
  } catch {
    return null;
  }
}

export function copySlideElements(clipboardData?: DataTransfer): boolean {
  const session = currentSession();
  if (!session?.history || !session.sceneId) return false;
  const ids = new Set(useCanvasStore.getState().activeElementIdList);
  const { elements, animations = [] } = session.history.present.canvas;
  const selected = elements.filter((element) => ids.has(element.id));
  if (!selected.length) return false;
  const payload: SlideClipboard = {
    format: 'coteach-slide-elements', version: 1, sourceSceneId: session.sceneId,
    elements: selected,
    animations: animations.filter((animation) => ids.has(animation.elId)),
  };
  localClipboard = JSON.stringify(payload);
  lastPaste = null;
  if (clipboardData) {
    clipboardData.setData(SLIDE_CLIPBOARD_MIME, localClipboard);
    clipboardData.setData('text/plain', localClipboard);
  } else {
    // Menu copy still succeeds locally when system clipboard access is denied.
    void navigator.clipboard?.writeText(localClipboard).catch(() => undefined);
  }
  return true;
}

export function cutSlideElements(clipboardData?: DataTransfer): boolean {
  if (!copySlideElements(clipboardData)) return false;
  const session = currentSession();
  if (!session) return false;
  session.applyOp({ type: 'element.deleteMany', elementIds: useCanvasStore.getState().activeElementIdList });
  useCanvasStore.getState().clearSelection();
  return true;
}

/** Paste all selected elements and their animations as one undo transaction. */
export function pasteSlideElements(text = localClipboard): boolean {
  const session = currentSession();
  const payload = text ? parseClipboard(text) : null;
  if (!session?.sceneId || !payload || !text) return false;
  const count = lastPaste?.text === text && lastPaste.sceneId === session.sceneId
    ? lastPaste.count + 1 : 0;
  const offset = 20 * (count + (payload.sourceSceneId === session.sceneId ? 1 : 0));
  const idMap = new Map(payload.elements.map((element) => [element.id, createElementId(element.type)]));
  const groups = new Map<string, string>();
  const elements = structuredClone(payload.elements).map((element) => {
    element.id = idMap.get(element.id)!;
    element.left += offset;
    element.top += offset;
    if (element.groupId) {
      if (!groups.has(element.groupId)) groups.set(element.groupId, createElementId('group'));
      element.groupId = groups.get(element.groupId);
    }
    return element;
  });
  const animations = payload.animations.map((animation) => ({
    ...animation, id: createElementId('animation'), elId: idMap.get(animation.elId)!,
  }));
  session.applyOp({ type: 'element.paste', elements, animations });
  useCanvasStore.getState().clearSelection();
  useCanvasStore.getState().setActiveElementIdList(elements.map((element) => element.id));
  localClipboard = text;
  lastPaste = { text, sceneId: session.sceneId, count };
  return true;
}

/** Context-menu paste; native keyboard paste supplies its own clipboard data. */
export async function pasteSlideElementsFromClipboard(): Promise<void> {
  const session = currentSession();
  if (!session) return;
  const stageId = useStageStore.getState().stage?.id;
  let text = localClipboard;
  try {
    if (navigator.clipboard?.readText) text = await navigator.clipboard.readText();
  } catch {
    // The in-memory copy remains usable without browser clipboard permissions.
  }
  if (currentSession()?.sceneId !== session.sceneId || useStageStore.getState().stage?.id !== stageId) return;
  pasteSlideElements(text);
}
