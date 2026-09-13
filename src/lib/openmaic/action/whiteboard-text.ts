/** Keep existing rich text; preserve line breaks and literal operators in plain board writing. */
export function whiteboardTextHtml(content: string, fontSize: number): string {
  if (content.startsWith('<')) return content;
  const escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br/>');
  return `<p style="font-size: ${fontSize}px;">${escaped}</p>`;
}
