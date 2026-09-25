import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTVideoElement } from '@openmaic/dsl';

const mocks = vi.hoisted(() => ({ playingId: '', pauseVideo: vi.fn(), warn: vi.fn() }));

vi.mock('motion/react', () => ({ useAnimate: () => [{ current: null }, vi.fn()] }));
vi.mock('@openmaic/lib/store/canvas', () => ({
  useCanvasStore: {
    use: { playingVideoElementId: () => mocks.playingId },
    getState: () => ({ pauseVideo: mocks.pauseVideo }),
  },
}));
vi.mock('@openmaic/lib/store/media-generation', () => ({
  useMediaGenerationStore: (selector: (state: { tasks: Record<string, never> }) => unknown) => selector({ tasks: {} }),
  isMediaPlaceholder: () => false,
}));
vi.mock('@openmaic/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: { videoGenerationEnabled: boolean }) => unknown) => selector({ videoGenerationEnabled: true }),
}));
vi.mock('@openmaic/lib/contexts/media-stage-context', () => ({ useMediaStageId: () => 'test-stage' }));
vi.mock('@openmaic/lib/media/video-manifest', () => ({ getVideoMediaRefForElement: () => undefined }));
vi.mock('@openmaic/lib/media/media-orchestrator', () => ({ retryMediaTask: vi.fn() }));
vi.mock('@openmaic/lib/logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ useI18n: () => ({
  t: (key: string) => key === 'settings.mediaPlaybackBlocked' ? '浏览器阻止了自动播放，请点击重试。' : '重试',
}) }));

import { BaseVideoElement } from './BaseVideoElement';

const video = {
  id: 'lesson-video', src: '/test-video.webm', left: 0, top: 0, width: 640, height: 360, rotate: 0,
} as PPTVideoElement;

describe('lesson video autoplay denial', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.playingId = '';
    mocks.pauseVideo.mockReset();
    mocks.warn.mockReset();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  it.each(['pointer', 'keyboard'])('shows a visible recovery control and plays after %s activation', async (activation) => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('Autoplay denied', 'NotAllowedError'))
      .mockResolvedValue(undefined);
    const view = render(<BaseVideoElement elementInfo={video} />);
    mocks.playingId = video.id;
    view.rerender(<BaseVideoElement elementInfo={video} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('浏览器阻止了自动播放');
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible();
    expect(document.querySelector('video')).toHaveAttribute('controls');
    const retry = screen.getByRole('button', { name: '重试' });
    if (activation === 'pointer') {
      fireEvent.pointerDown(retry, { pointerType: 'mouse' });
      fireEvent.click(retry, { detail: 1 });
    } else {
      fireEvent.click(retry, { detail: 0 });
    }
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(play).toHaveBeenCalledTimes(2);
  });
});
