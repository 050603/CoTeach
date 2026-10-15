import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeachingKnowledgeGraphProvider } from '@/components/openmaic-bridge/knowledge-graph-context';
import type { CourseMindMap } from '@/lib/course-mind-map/types';
import type { PlaybackModalBlockDetail } from '@openmaic/lib/playback/activity-events';
import { CourseKnowledgeGraphButton } from './course-knowledge-graph-button';

const stage = vi.hoisted(() => ({
  getCurrentScene: () => ({
    id: 'scene', knowledgePointIds: ['anchor'],
    actions: [{ id: 'speech', type: 'speech', text: '先创设情境，再确定问题。',
      speechAlignment: { status: 'aligned', textHash: 'text', audioHash: 'audio' } }],
  }),
}));
vi.mock('@openmaic/lib/store', () => ({
  useStageStore: (select: (state: typeof stage) => unknown) => select(stage),
}));
vi.mock('@/components/course-mind-map-flow', () => ({
  CourseMindMapFlow: ({ activeNodeId }: { activeNodeId?: string | null }) => <div
    aria-label="概念导图" data-active-node={activeNodeId} role="application"
  />,
}));
vi.mock('@/components/knowledge-graph-flow', () => ({
  KnowledgeGraphFlow: () => <div aria-label="旧知识图谱" role="application" />,
}));
const map: CourseMindMap = {
  schemaVersion: 1, sourceFingerprint: 'source', bindingFingerprint: 'binding', rootId: 'course',
  nodes: [
    { id: 'course', label: '教学方法', knowledgePointIds: [] },
    { id: 'anchor', label: '抛锚式教学法', parentId: 'course', knowledgePointIds: ['anchor'] },
    { id: 'context', label: '创设情境', parentId: 'anchor', knowledgePointIds: ['anchor'] },
    { id: 'problem', label: '确定问题', parentId: 'anchor', knowledgePointIds: ['anchor'] },
  ], relations: [], diagnostics: [],
  bindings: [{ sceneId: 'scene', defaultNodeId: 'anchor', cues: [
    { speechId: 'speech', nodeId: 'context', anchor: { quote: '创设情境' }, startMs: 500, speechTextHash: 'text', audioHash: 'audio' },
    { speechId: 'speech', nodeId: 'problem', anchor: { quote: '确定问题' }, startMs: 3200, speechTextHash: 'text', audioHash: 'audio' },
  ] }],
};

describe('course concept map dialog', () => {
  it('projects the same real playback position while blocking playback and restoring focus', async () => {
    const events: PlaybackModalBlockDetail[] = [];
    const onBlock = (event: Event) => events.push((event as CustomEvent<PlaybackModalBlockDetail>).detail);
    window.addEventListener('openmaic:playback-modal-block', onBlock);
    const view = (mediaTimeMs: number) => <TeachingKnowledgeGraphProvider mindMap={map} points={[]} graph={{
      nodes: [{ id: 'legacy', label: '长篇页面标题', description: '' }], edges: [],
    }}><CourseKnowledgeGraphButton activeActionIndex={0} mediaTimeMs={mediaTimeMs} /></TeachingKnowledgeGraphProvider>;
    try {
      const { rerender } = render(view(1000));
      const trigger = screen.getByRole('button', { name: '完整浏览课程思维导图' });
      trigger.focus();
      fireEvent.click(trigger);
      expect(screen.getByRole('application', { name: '概念导图' })).toHaveAttribute('data-active-node', 'context');
      expect(screen.queryByRole('application', { name: '旧知识图谱' })).toBeNull();
      expect(events).toEqual([{ blocked: true, source: 'course-knowledge-graph', restorePlayback: true }]);
      rerender(view(4500));
      expect(screen.getByRole('application', { name: '概念导图' })).toHaveAttribute('data-active-node', 'problem');
      rerender(view(0));
      expect(screen.getByRole('application', { name: '概念导图' })).toHaveAttribute('data-active-node', 'anchor');
      fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
      expect(events).toEqual([
        { blocked: true, source: 'course-knowledge-graph', restorePlayback: true },
        { blocked: false, source: 'course-knowledge-graph', restorePlayback: true },
      ]);
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      window.removeEventListener('openmaic:playback-modal-block', onBlock);
    }
  });

  it('keeps legacy courses browsable through the existing graph', () => {
    render(<TeachingKnowledgeGraphProvider points={[{ id: 'legacy', name: '原知识点', description: '' }]}>
      <CourseKnowledgeGraphButton />
    </TeachingKnowledgeGraphProvider>);
    fireEvent.click(screen.getByRole('button', { name: '完整浏览课程思维导图' }));
    expect(screen.getByRole('application', { name: '旧知识图谱' })).toBeInTheDocument();
  });
});
