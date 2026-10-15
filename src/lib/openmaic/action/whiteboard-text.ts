/** Keep existing rich text; preserve line breaks and literal operators in plain board writing. */
export function whiteboardTextHtml(content: string, fontSize: number): string {
  if (content.startsWith('<')) {
    // Unstyled model-authored paragraphs must inherit the same size measured
    // by layout. Preserve explicitly sized rich text from existing boards.
    return /font-size\s*:/i.test(content) ? content : `<div style="font-size: ${fontSize}px;">${content}</div>`;
  }
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br/>');
  return `<p style="font-size: ${fontSize}px;">${escaped}</p>`;
}
