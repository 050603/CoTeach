import { act, renderHook, waitFor } from '@testing-library/react';
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene, Stage } from '@openmaic/lib/types/stage';

interface RuntimeOptions {
  messages: ThreadMessageLike[];
  onNew: (message: AppendMessage) => Promise<void>;
}
interface RuntimeStore {
  stage: Stage;
  scenes: Scene[];
  outlines: [];
  getSceneById: (id: string) => Scene | null;
}

const mocks = vi.hoisted(() => ({
  options: null as RuntimeOptions | null,
  state: null as RuntimeStore | null,
  fetch: vi.fn(),
  apply: vi.fn(),
  plan: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@assistant-ui/react', () => ({ useExternalStoreRuntime: (options: RuntimeOptions) => { mocks.options = options; return {}; } }));
vi.mock('@openmaic/lib/store/stage', () => ({
  useStageStore: Object.assign(
    (selector: (state: RuntimeStore) => unknown) => selector(mocks.state!),
    { getState: () => mocks.state! },
  ),
}));
vi.mock('@openmaic/lib/utils/model-config', () => ({ getCurrentModelConfig: () => ({}) }));
vi.mock('./apply-slide-content', () => ({ applyScenePatchInSync: mocks.apply }));
vi.mock('./apply-regenerate', () => ({ planRegenerateApply: mocks.plan }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('./agent-thread-store', () => ({
  createSession: (stageId: string) => ({ id: 'session', stageId, messages: [] }),
  saveSession: async () => {},
  loadSession: async () => undefined,
  listSessions: async () => [],
  deleteSession: async () => {},
  migrateLegacyThread: async () => {},
  rememberActiveSession: () => {},
  recallActiveSession: () => undefined,
}));

import { useAgentRuntime } from './use-agent-runtime';

const prompt: AppendMessage = {
  role: 'user',
  content: [{ type: 'text', text: '修改白板' }],
  createdAt: new Date(0),
  metadata: { custom: {} },
  parentId: null,
  sourceId: null,
  runConfig: undefined,
};
const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

beforeEach(() => {
  vi.clearAllMocks();
  const scene: Scene = {
    id: 's1', stageId: 'c1', order: 0, title: '页面', type: 'slide',
    content: { type: 'slide', canvas: {
      id: 'canvas', elements: [], viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' },
    } },
    actions: [{ id: 'speech', type: 'speech', text: '当前讲稿' }],
  };
  mocks.state = {
    stage: { id: 'c1', name: '课堂', createdAt: 1, updatedAt: 1 },
    scenes: [scene], outlines: [], getSceneById: (id) => id === scene.id ? scene : null,
  };
  mocks.plan.mockReturnValue({ snapshot: null, patch: { actions: [] } });
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('AI editor runtime lifecycle', () => {
  it('sends current narration and ignores a tool response after editor unmount', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start: (controller) => { stream = controller; } })));
    const { unmount } = renderHook(() => useAgentRuntime({ scene: { id: 's1', title: '页面' }, courseId: 'course-1' }));
    let task!: Promise<void>;
    await act(async () => { task = mocks.options!.onNew(prompt); });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    const request = mocks.fetch.mock.calls[0][1];
    expect(JSON.parse(request.body)).toMatchObject({ courseId: 'course-1', sceneContextMap: { s1: { actions: mocks.state!.scenes[0].actions } } });
    unmount();
    expect(request.signal.aborted).toBe(true);
    stream.enqueue(encode({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'regenerate_scene_actions', result: { details: { sceneId: 's1', actions: [{ type: 'speech', text: '旧响应' }] } } }));
    stream.close();
    await task;
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('shows an explicit failure when a whiteboard result conflicts with manual edits', async () => {
    const error = '白板内容已修改，请重新提出编辑要求';
    mocks.plan.mockReturnValue({ snapshot: null, patch: null, error });
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encode({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'edit_whiteboard', arguments: { sceneId: 's1' } }] } }));
      controller.enqueue(encode({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'edit_whiteboard', result: { details: { sceneId: 's1' } } }));
      controller.close();
    } })));
    renderHook(() => useAgentRuntime({ scene: { id: 's1', title: '页面' } }));
    await act(async () => { await mocks.options!.onNew(prompt); });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(error);
    expect(mocks.options!.messages.at(-1)?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool-call', isError: true }),
      { type: 'text', text: error },
    ]));
  });
});
