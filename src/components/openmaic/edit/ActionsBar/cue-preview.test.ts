import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import { cuePreviewFor } from './cue-preview';

describe('cuePreviewFor', () => {
  it('preserves a fine-grained selector for spotlight and laser previews', () => {
    expect(cuePreviewFor({
      id: 'focus', type: 'spotlight', elementId: 'table', selector: { cellId: 'r3c2' },
    } as Action)).toEqual({
      kind: 'spotlight', elementId: 'table', selector: { cellId: 'r3c2' },
    });
    expect(cuePreviewFor({
      id: 'point', type: 'laser', elementId: 'text', selector: { quote: 'PBL', occurrence: 0 },
    } as Action)).toEqual({
      kind: 'laser', elementId: 'text', selector: { quote: 'PBL', occurrence: 0 },
    });
  });
});
