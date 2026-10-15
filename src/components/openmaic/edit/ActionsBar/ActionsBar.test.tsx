import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { Scene, ScenePatch } from '@openmaic/lib/types/stage';

vi.mock('@openmaic/lib/store/stage', async () => {
  const { create } = await import('zustand');
  return {
    useStageStore: create<{
      scenes: Scene[];
      getSceneById: (id: string) => Scene | undefined;
      updateScene: (id: string, patch: ScenePatch) => void;
    }>((set, get) => ({
      scenes: [],
      getSceneById: (id) => get().scenes.find((scene) => scene.id === id),
      updateScene: vi.fn((id, patch) => set((state) => ({
        scenes: state.scenes.map((scene) => scene.id === id ? ({ ...scene, ...patch } as Scene) : scene),
      }))),
    })),
  };
});
vi.mock('@openmaic/lib/audio/regenerate-speech-tts', () => ({
  audioExists: vi.fn(async () => false),
  audioObjectUrl: vi.fn(),
  discardSpeechAudio: vi.fn(async () => undefined),
  regenerateSpeechAudio: vi.fn(),
  resolveSpeechAudioId: () => 'audio',
  speechAudioId: () => 'audio',
}));
vi.mock('./WhiteboardEditor', () => ({ WhiteboardEditor: () => null }));

import { I18nProvider } from '@openmaic/lib/hooks/use-i18n';
import { useStageStore } from '@openmaic/lib/store/stage';
import { useSettingsStore } from '@openmaic/lib/store/settings';
import { ActionsBar } from './ActionsBar';

const action = (value: Record<string, unknown>): Action => value as unknown as Action;

function renderTimeline(actions: Action[]) {
  useStageStore.setState({ scenes: [{ id: 'scene', type: 'slide', order: 0, title: '关系图', actions } as Scene] });
  return render(<I18nProvider locale="zh-CN"><ActionsBar sceneId="scene" /></I18nProvider>);
}

beforeEach(() => {
  useSettingsStore.setState({ ttsEnabled: false, selectedAgentIds: [] });
  vi.clearAllMocks();
});

describe('wait actions in the narration timeline', () => {
  it('renders both kinds of empty-text waits as timing cards and leaves the scene untouched', () => {
    const actions = [
      action({ id: 'speech', type: 'speech', text: '观察关系图。' }),
      action({ id: 'reflection', type: 'speech', text: '', timelinePauseSec: 12.5, timelinePausePurpose: 'learner-reflection' }),
      action({ id: 'activity', type: 'speech', text: '', activityPauseSec: 60 }),
    ];
    renderTimeline(actions);
    expect(screen.getAllByPlaceholderText('输入这一句讲解…')).toHaveLength(1);
    expect(screen.getByText('计划停顿 12.5 秒')).toBeInTheDocument();
    expect(screen.getByText('最长等待 60 秒')).toBeInTheDocument();
    expect(screen.getByText('1 讲解 · 2 动作')).toBeInTheDocument();
    expect(screen.queryByTitle('讲稿为空')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '时间线停顿' }));
    expect(screen.getByText('短暂停顿后继续')).toBeInTheDocument();
    expect(screen.getByText('阅读与思考')).toBeInTheDocument();
    expect(useStageStore.getState().getSceneById('scene')!.actions).toEqual(actions);
    expect(useStageStore.getState().updateScene).not.toHaveBeenCalled();
  });

  it.each(['activityPauseSec', 'timelinePauseSec'])('keeps an empty speech warning when %s is not finite', (field) => {
    renderTimeline([action({ id: 'invalid', type: 'speech', text: '', [field]: Infinity })]);
    expect(screen.getByPlaceholderText('输入这一句讲解…')).toBeInTheDocument();
    expect(screen.getByTitle('讲稿为空')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '讲解' }));
    expect(screen.getByText('讲稿为空')).toBeInTheDocument();
    expect(screen.queryByText('计划时长')).not.toBeInTheDocument();
  });
});
