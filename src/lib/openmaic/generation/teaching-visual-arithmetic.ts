/** Small, closed arithmetic verifier. It never executes model-supplied code. */
function normalized(value: string): string { return String(Number(value)); }
function formula(value: string): string {
  return value.replace(/−/gu, '-').replace(/×/gu, '*').replace(/÷/gu, '/').replace(/\s+/gu, '');
}

export function groundedNumericValues(text: string): Set<string> {
  const values = new Set([...text.replace(/−/gu, '-').matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => normalized(match[0])));
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  for (const [value, word] of words.entries()) if (new RegExp(`\\b${word}\\b`, 'iu').test(text)) values.add(String(value));
  for (const [word, value] of [['零', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10]] as const) {
    if (new RegExp(`${word}(?:日|天|次|个|盏|种|组|项|步|人)`, 'u').test(text)) values.add(String(value));
  }
  return values;
}

function evaluate(expression: string): number | null {
  const input = formula(expression);
  if (input.length > 300) return null;
  const tokens = input.match(/\d+(?:\.\d+)?|[()+\-*/]/gu) ?? [];
  if (tokens.join('') !== input) return null;
  let cursor = 0;
  const atom = (): number => {
    const token = tokens[cursor++];
    if (token === '+') return atom();
    if (token === '-') return -atom();
    if (token === '(') { const value = sum(); if (tokens[cursor++] !== ')') throw new Error('unclosed'); return value; }
    if (!token || !/^\d/u.test(token)) throw new Error('number expected');
    return Number(token);
  };
  const product = (): number => {
    let value = atom();
    while (tokens[cursor] === '*' || tokens[cursor] === '/') {
      const op = tokens[cursor++], right = atom();
      if (op === '/' && right === 0) throw new Error('zero divisor');
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[cursor] === '+' || tokens[cursor] === '-') {
      const op = tokens[cursor++], right = product();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  try { const value = sum(); return cursor === tokens.length && Number.isFinite(value) ? value : null; }
  catch { return null; }
}

function equations(text: string): Array<{ expression: string; result: string }> {
  // Start at an operand, so the introductory "power difference = 60" cannot
  // consume 60 before the actual "60 − 10 = 50" equality is inspected.
  return [...text.matchAll(/([+\-−]?\s*(?:\d+(?:\.\d+)?|\()[\d.()+\-−×÷*/\s]*)\s*=\s*(-?\d+(?:\.\d+)?)/gu)]
    .map((match) => ({ expression: match[1]!.trim(), result: match[2]! }))
    .filter((item) => /[+\-*/]/u.test(formula(item.expression)));
}

/** Derived values must have a true numeric equality, adopted operands, and
 * either an adopted result or an exact subexpression of an adopted formula.
 * This allows teaching intermediate steps, not invented measurements. */
export function verifiedTeachingArithmetic(texts: readonly string[], originalTexts: readonly string[]): {
  quantitiesByText: Map<string, Set<string>>; invalidTexts: Set<string>;
} {
  const originals = originalTexts.join('\n'), known = groundedNumericValues(originals);
  const sourceFormula = formula(originals).replace(/[()]/gu, '');
  const derived = new Map<string, string>(), quantitiesByText = new Map<string, Set<string>>(), invalidTexts = new Set<string>();
  for (let pass = 0; pass <= texts.length; pass += 1) {
    let changed = false;
    for (const text of texts) for (const equality of equations(text)) {
      const operands = [...equality.expression.matchAll(/\d+(?:\.\d+)?/gu)].map((match) => normalized(match[0]));
      if (operands.some((operand) => !known.has(operand) && !derived.has(operand))) continue;
      const value = evaluate(equality.expression), result = Number(equality.result);
      if (value === null || Math.abs(value - result) > Math.max(1, Math.abs(value), Math.abs(result)) * 1e-9) {
        invalidTexts.add(text); continue;
      }
      const expanded = formula(equality.expression).replace(/\d+(?:\.\d+)?/gu,
        (operand) => derived.has(normalized(operand)) ? `(${derived.get(normalized(operand))!})` : operand);
      if (!known.has(normalized(equality.result)) && !sourceFormula.includes(expanded.replace(/[()]/gu, ''))) continue;
      const quantities = quantitiesByText.get(text) ?? new Set<string>();
      for (const token of [...equality.expression.matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => match[0])) quantities.add(token);
      quantities.add(equality.result); quantitiesByText.set(text, quantities);
      const key = normalized(equality.result);
      if (!known.has(key) && !derived.has(key)) { derived.set(key, expanded); changed = true; }
    }
    if (!changed) break;
  }
  return { quantitiesByText, invalidTexts };
}
