/**
 * Remove contradictory sentence terminators introduced when independently
 * authored prose clauses are joined with a semicolon. The last mark wins, so
 * `。；` remains a clause separator while `；。` remains a sentence ending.
 */
export function normalizeNarrationPunctuation(value: string): string {
  return value
    .replace(/[。．.]+[ \t]*([；;]+)/g, (_match, semicolons: string) => semicolons.at(-1) ?? '')
    .replace(/[；;]+[ \t]*([。．.]+)/g, (_match, periods: string) => periods.at(-1) ?? '')
    .replace(/[；;](?:[ \t]*[；;])+/g, (semicolons) => (
      [...semicolons].reverse().find((character) => character === '；' || character === ';') ?? ''
    ));
}
