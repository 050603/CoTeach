/** One native authoring envelope: real native elements and measured components
 * have separate arrays. Container normalization never edits teaching content,
 * typography, geometry, relationships or references. */
export function normalizeNativeAuthoringEnvelope(response: string): string {
  const plain = response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, '$1');
  let value: unknown;
  try { value = JSON.parse(plain); } catch { return response; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return response;
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.elements) || page.layout !== undefined
    || (page.components !== undefined && !Array.isArray(page.components))) return response;
  const native: unknown[] = [];
  const moved: unknown[] = [];
  for (const entry of page.elements) {
    const component = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined;
    if (component && !Object.hasOwn(component, 'type')
      && ['textBox', 'labelGrid', 'diagram'].includes(String(component.kind))) moved.push(entry);
    else native.push(entry);
  }
  if (!moved.length) return response;
  return JSON.stringify({ ...page, elements: native, components: [...(page.components as unknown[] | undefined ?? []), ...moved] });
}

export function nativeAuthoringEnvelopeContract(referenceId?: string): string {
  const example = { background: { type: 'solid', color: '#ffffff' },
    elements: [{ type: 'text', id: 'page-heading', left: 60, top: 50, width: 880, height: 70,
      content: '<p style="font-size:32px">Use the supplied page title here</p>' }],
    components: [{ kind: 'textBox', id: 'adopted-body-point', role: 'body', left: 60, top: 145, width: 880,
      fontSize: 24, ...(referenceId ? { contentRef: referenceId } : { text: 'A complete adopted presentation point' }) }],
  };
  return `## Single native response envelope
Return one JSON object with background, elements and components, as illustrated here: ${JSON.stringify(example)}
The two arrays have different grammars: elements contains native objects discriminated by type (text, shape, line, table, image, chart, video or latex). components contains local helpers discriminated by kind (textBox, labelGrid or diagram). Never put kind:textBox or kind:labelGrid in elements, and never wrap native elements in kind:native for this native-page contract. Native type:text accepts contentRef/paragraphRefs directly; measured kind:textBox accepts them only as an entry of components. Preserve all required references across the complete page; the example demonstrates the envelope, not a required composition or permission to omit other points.
Adopted definitions, explanations and relationships are body content: use role:body and readable body typography (22–28px), even when each statement begins with a short concept name. Do not mark complete statements as labels to invoke smaller defaults.
Place all complete measured rectangles inside x=50..950 and y=50..512.5. For each point, top + its full measured height must be <=512.5; for stacked neighbors, previous top + its full measured height + the intended gap must be <= next top. The authored height is only an estimate and cannot cap the full referenced text. Choose measured width/font candidates and allocate space for bold text without shortening points or lowering body typography. Check the final bottom-most content, not only the combined text height.`;
}
