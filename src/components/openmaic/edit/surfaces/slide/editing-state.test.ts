import { describe, expect, it } from 'vitest';
import { createDefaultImageElement, createDefaultTextElement } from '@openmaic/lib/edit/slide-edit-elements';
import { resolveEditingElementId, resolveSelectedElement } from './editing-state';

const elements = [
  { ...createDefaultTextElement('label'), groupId: 'diagram' },
  { ...createDefaultImageElement('image', '/image.png'), groupId: 'diagram' },
  { ...createDefaultTextElement('other'), groupId: 'other-diagram' },
];

describe('grouped diagram local editing selection', () => {
  it('opens a text format or image replacement bar for the explicitly handled group member', () => {
    const ids = ['label', 'image'];
    expect(resolveEditingElementId(ids, elements, 'label')).toBe('label');
    expect(resolveSelectedElement(ids, elements, 'image')).toEqual(elements[1]);
    expect(resolveEditingElementId(ids, elements, 'image')).toBe('');
  });

  it('keeps whole-group selection and mixed groups at component scope', () => {
    expect(resolveSelectedElement(['label', 'image'], elements)).toBeUndefined();
    expect(resolveSelectedElement(['label', 'other'], elements, 'label')).toBeUndefined();
  });

  it('ignores stale handled IDs and preserves ordinary single selection', () => {
    expect(resolveSelectedElement(['other'], elements, 'image')).toEqual(elements[2]);
    expect(resolveSelectedElement(['label', 'image'], elements, 'missing')).toBeUndefined();
    expect(resolveEditingElementId(['label'], elements)).toBe('label');
  });
});
