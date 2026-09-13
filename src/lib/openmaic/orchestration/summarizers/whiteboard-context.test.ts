import { describe, expect, it } from 'vitest';
import type { StatelessChatRequest } from '@openmaic/lib/types/chat';
import type { WhiteboardActionRecord } from '../types';
import { buildWhiteboardConflicts } from './whiteboard-conflicts';
import { buildVirtualWhiteboardContext } from './whiteboard-ledger';
import { buildStateContext } from './state-context';

const shape = { id: 'node', type: 'shape', left: 40, top: 80, width: 200, height: 120 };
const label = { id: 'label', type: 'text', content: '观察', left: 60, top: 100, width: 160, height: 60 };
const arrow = { id: 'line', type: 'line', left: 240, top: 140, start: [0, 0], end: [200, 0], whiteboard: { action: { startAnchor: { elementId: 'node', side: 'right' } } } };
const state = { mode: 'playback', whiteboardOpen: true, scenes: [], currentSceneId: 'current' } as unknown as StatelessChatRequest['storeState'];

describe('whiteboard context for AI', () => {
  it('does not mistake a contained label or attached boundary arrow for a collision', () => {
    expect(buildWhiteboardConflicts([shape, label, arrow])).toBe('');
    expect(buildWhiteboardConflicts([label, { ...label, id: 'overlap', left: 70 }])).toContain('OVERLAP');
    expect(buildWhiteboardConflicts([shape, arrow, { id: 'obstacle', type: 'text', content: '解释', left: 320, top: 100, width: 80, height: 80 }])).toContain('LINE CROSSES');
  });
  it('tracks IDs, redraws and attached deletions across agent turns', () => {
    const record = (actionName: string, params: Record<string, unknown>) => ({ agentName: '教师', actionName, params }) as WhiteboardActionRecord;
    const ledger = [
      record('wb_draw_text', { elementId: 'note', content: '旧内容', x: 40, y: 40 }),
      record('wb_draw_text', { elementId: 'note', content: '新内容', x: 40, y: 140 }),
      record('wb_draw_line', { elementId: 'arrow', startX: 240, startY: 140, endX: 440, endY: 140, startAnchor: { elementId: 'note', side: 'right' } }),
    ];
    const context = buildVirtualWhiteboardContext(state, ledger);
    expect(context).toContain('[id=note]');
    expect(context).toContain('新内容');
    expect(context).not.toContain('旧内容');
    expect(context).toContain('note.right');
    expect(buildVirtualWhiteboardContext(state, [...ledger, record('wb_delete', { elementId: 'note' })])).toBe('');
  });
  it('reads the current scene board even if another board was created later', () => {
    const context = buildStateContext({ ...state, stage: {
      id: 'stage', name: '课程', whiteboard: [
        { id: 'whiteboard-scene:current', elements: [{ ...label, content: '本页板书' }] },
        { id: 'whiteboard-scene:other', elements: [{ ...label, content: '其他页板书' }] },
      ],
    } } as unknown as StatelessChatRequest['storeState']);
    expect(context).toContain('本页板书');
    expect(context).not.toContain('其他页板书');
  });
});
