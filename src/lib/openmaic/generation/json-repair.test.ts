import { describe, expect, it } from 'vitest';
import { normalizeFullWidthJsonSyntax, tryParseJson } from './json-repair';

describe('AI JSON repair', () => {
  it('normalizes full-width separators outside strings without changing teaching prose', () => {
    const malformed = '{"pages":[{"examples":["先比较，后判断：证据是否独立"] ，"conditions":["适用：有来源"]}]}';

    expect(normalizeFullWidthJsonSyntax(malformed)).toBe(
      '{"pages":[{"examples":["先比较，后判断：证据是否独立"] ,"conditions":["适用：有来源"]}]}',
    );
    expect(tryParseJson<{ pages: Array<{ examples: string[]; conditions: string[] }> }>(malformed))
      .toEqual({
        pages: [{
          examples: ['先比较，后判断：证据是否独立'],
          conditions: ['适用：有来源'],
        }],
      });
  });
});
