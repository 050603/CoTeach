import type { GeneratedSlideContent, PdfImage } from '../types/generation';

/** A classroom slide has one audience-independent canvas. Provenance and
 * preparation instructions belong to the saved evidence/authoring records. */
export const CLASSROOM_SLIDE_CONTENT_POLICY = '教师端和学生端使用同一份课堂 PPT。书目出处、来源页码和教师专用备课/编辑/审阅提示留在系统记录及教师报告，不写进可见页面；真实来源 ID 与证据绑定必须保留。教学事实、必要条件、观察说明、解释性图注及实际所教的教学法原则继续显示。';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === 'object' && !Array.isArray(value);
const plain = (value: string) => value.replace(/<[^>]*>/gu, '').replace(/&nbsp;|&#160;/giu, ' ')
  .replace(/&(?:lt|gt|amp);/giu, ' ').trim();
const editorial = /^(?:来源|出处|图源|图片来源|教材来源|资料来源|source(?:s)?|image\s+credit|教师(?:端|专用)?提示|备课提示|授课提示|口播提示|编辑提示|审阅提示)\s*[:：]/iu;
const hasRefs = (slot: Record<string, unknown>) => typeof slot.contentRef === 'string'
  || Array.isArray(slot.paragraphRefs) && slot.paragraphRefs.length > 0;

/** Only explicit standalone editorial paragraphs are suppressed. A bound
 * teaching statement, even about a source, must not be classified by keywords. */
function classroomText(value: string): string {
  const paragraphs = /<(?:p|div)\b[^>]*>[\s\S]*?<\/(?:p|div)>/giu;
  const result = value.replace(paragraphs, (paragraph) => editorial.test(plain(paragraph)) ? '' : paragraph);
  return editorial.test(plain(result)) ? '' : result;
}

/** Apply before local measurement so an editorial caption cannot consume
 * teaching capacity or trigger a diagram fallback. Does not mutate the raw
 * response which is separately saved for audit and checkpoint identity. */
export function applyClassroomSlideAuthoringPolicy(native: Record<string, unknown>): void {
  const cleanSlot = (slot: Record<string, unknown>, protectedBody = false) => {
    if (protectedBody || hasRefs(slot)) return;
    for (const field of ['content', 'text'] as const) if (typeof slot[field] === 'string') {
      slot[field] = classroomText(slot[field]);
    }
    if (Array.isArray(slot.paragraphs)) slot.paragraphs = slot.paragraphs
      .map((entry) => typeof entry === 'string' ? classroomText(entry) : entry)
      .filter((entry) => entry !== '');
  };
  if (Array.isArray(native.elements)) native.elements = native.elements.filter((element) => {
    if (!record(element)) return true;
    if (element.type === 'text') {
      cleanSlot(element, element.textType === 'title');
      return hasRefs(element) || typeof element.content !== 'string' || Boolean(plain(element.content));
    }
    if (element.type === 'shape' && record(element.text)) cleanSlot(element.text);
    if (element.type === 'table' && Array.isArray(element.data)) {
      for (const cell of element.data.flat()) if (record(cell)) cleanSlot(cell);
    }
    return true;
  });
  if (Array.isArray(native.components)) native.components = native.components.filter((component) => {
    if (!record(component) || component.kind !== 'textBox') return true;
    cleanSlot(component, component.role === 'title');
    return hasRefs(component) || Boolean(plain(String(component.text ?? '')))
      || Array.isArray(component.paragraphs) && component.paragraphs.length > 0;
  });
}

/** Protect actual body slots after compilation; only attribution bindings
 * identify a removable label. Source catalogs and display duties are unchanged. */
export function applyClassroomSlideContentPolicy(content: GeneratedSlideContent): GeneratedSlideContent {
  const protectedIds = new Set((content.contentBindings ?? [])
    .filter((binding) => !/^image:.*:caption$/u.test(binding.sourceContentId)).map((binding) => binding.elementId));
  const native: Record<string, unknown> = { elements: content.elements.map((element) => {
    if (protectedIds.has(element.id)) return element;
    if (element.type === 'shape' && element.text) return { ...element, text: { ...element.text } };
    if (element.type === 'table') return { ...element, data: element.data.map((row) => row.map((cell) => ({ ...cell }))) };
    return { ...element };
  }) };
  // Exclude teaching-bound elements from the literal-only filter completely.
  const protectedElements = new Map(content.elements.filter((element) => protectedIds.has(element.id)).map((element) => [element.id, element]));
  const editable = native.elements as GeneratedSlideContent['elements'];
  native.elements = editable.filter((element) => !protectedIds.has(element.id));
  applyClassroomSlideAuthoringPolicy(native);
  const retained = new Map((native.elements as GeneratedSlideContent['elements']).map((element) => [element.id, element]));
  const elements = content.elements.flatMap((element) => protectedElements.has(element.id) ? [element]
    : retained.has(element.id) ? [retained.get(element.id)!] : []);
  const ids = new Set(elements.map((element) => element.id));
  return { ...content, elements,
    ...(content.contentBindings ? { contentBindings: content.contentBindings.filter((binding) => ids.has(binding.elementId)) } : {}),
    ...(content.continuationPages ? { continuationPages: content.continuationPages.map(applyClassroomSlideContentPolicy) } : {}) };
}

/** Images retain their evidence/resource identity without appending a source
 * label to the shared canvas. The authoritative image catalog remains saved. */
export function retainNativeImageBindings(content: GeneratedSlideContent, images: PdfImage[]): GeneratedSlideContent {
  const bindings = [...(content.contentBindings ?? [])];
  for (const image of images) {
    const placed = content.elements.find((element) => element.type === 'image' && (element.id === image.id || element.src === image.src));
    if (placed && !bindings.some((binding) => binding.sourceContentId === `image:${image.id}` && binding.elementId === placed.id)) {
      bindings.push({ sourceContentId: `image:${image.id}`, elementId: placed.id });
    }
  }
  return { ...content, contentBindings: bindings };
}
