import { describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import type { ActionEngine } from '@openmaic/lib/action/engine';
import type { AudioPlayer } from '@openmaic/lib/utils/audio-player';
import type { PlaybackModalBlockDetail } from './activity-events';
import { PlaybackEngine } from './engine';
import { applyPlaybackModalBlock, createPlaybackModalGateState, transitionPlaybackModalGate } from './modal-gate';

const openMap: PlaybackModalBlockDetail = { blocked: true, source: 'course-knowledge-graph', restorePlayback: true };
const closeMap: PlaybackModalBlockDetail = { ...openMap, blocked: false };

async function playingLecture(withTrigger = false) {
  const media = { paused: true, ended: false, currentTime: 2.5 };
  const audio = {
    play: vi.fn(async () => { media.paused = false; return true; }),
    onEnded: vi.fn(),
    pause: vi.fn(() => { media.paused = true; }),
    resume: vi.fn(() => { if (!media.ended) media.paused = false; }),
    stop: vi.fn(() => { media.paused = true; }),
    isPlaying: () => !media.paused && !media.ended,
    hasActiveAudio: () => !media.ended,
    getCurrentTime: () => media.currentTime * 1000,
    getDuration: () => 10_000,
  };
  const scene = {
    id: 'lecture', stageId: 'stage', order: 0, title: '抛锚式教学法', type: 'slide',
    content: { type: 'slide', elements: [] },
    actions: [{ id: 'speech', type: 'speech', text: '先创设情境，再确定问题。', audioUrl: '/speech.wav' }],
  } as unknown as Scene;
  const engine = new PlaybackEngine([scene], {
    execute: vi.fn().mockResolvedValue(undefined), clearEffects: vi.fn(), pauseEffects: vi.fn(), resumeEffects: vi.fn(),
  } as unknown as ActionEngine, audio as unknown as AudioPlayer);
  engine.start();
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  if (withTrigger) {
    // Reproduce the real gate branch: a visible trigger can coexist with media.
    (engine as unknown as { currentTrigger: { id: string; question: string } }).currentTrigger = {
      id: 'trigger', question: '继续讲解吗？',
    };
  }
  let state = createPlaybackModalGateState<PlaybackEngine>();
  const send = (detail: PlaybackModalBlockDetail) => {
    const result = applyPlaybackModalBlock(state, detail, { engine, sceneId: scene.id, active: true, audio });
    state = result.state;
    return result;
  };
  return { engine, audio, media, send };
}

describe('modal lecture playback gate', () => {
  it('freezes actual audio and resumes the same clip without changing its playback position', async () => {
    const { engine, media, send } = await playingLecture();
    try {
      expect(media.paused).toBe(false);
      send(openMap);
      expect(engine.getMode()).toBe('paused');
      expect(media.paused).toBe(true);
      expect(media.currentTime).toBe(2.5);
      send(closeMap);
      expect(engine.getMode()).toBe('playing');
      expect(media.paused).toBe(false);
      expect(media.currentTime).toBe(2.5);
    } finally { engine.stop(); }
  });

  it('also pauses and restores media when the trigger-card engine branch skips audio', async () => {
    const { engine, audio, media, send } = await playingLecture(true);
    try {
      send(openMap);
      expect(engine.getMode()).toBe('paused');
      expect(media.paused).toBe(true);
      expect(audio.pause).toHaveBeenCalledOnce();
      send(closeMap);
      expect(engine.getMode()).toBe('playing');
      expect(media.paused).toBe(false);
      expect(audio.resume).toHaveBeenCalledOnce();
      expect(media.currentTime).toBe(2.5);
    } finally { engine.stop(); }
  });

  it('keeps a lecture that was already paused paused after browsing the map', async () => {
    const { engine, audio, media, send } = await playingLecture();
    try {
      engine.pause();
      send(openMap);
      send(closeMap);
      expect(engine.getMode()).toBe('paused');
      expect(media.paused).toBe(true);
      expect(audio.resume).not.toHaveBeenCalled();
    } finally { engine.stop(); }
  });

  it('does not restore trigger audio that was already paused or has ended', async () => {
    for (const kind of ['paused', 'ended'] as const) {
      const { engine, audio, media, send } = await playingLecture(true);
      try {
        if (kind === 'paused') media.paused = true;
        send(openMap);
        if (kind === 'ended') media.ended = true;
        send(closeMap);
        expect(media.paused).toBe(true);
        expect(audio.resume).not.toHaveBeenCalled();
        expect(media.currentTime).toBe(2.5);
      } finally { engine.stop(); }
    }
  });

  it('keeps nested sources blocked until the last opted-in overlay closes', async () => {
    const { engine, media, send } = await playingLecture(true);
    try {
      send(openMap);
      send({ ...openMap, source: 'nested-map' });
      send({ blocked: false, source: 'unknown-overlay' });
      const waiting = send(closeMap);
      expect(waiting.state.sources.size).toBe(1);
      expect(engine.getMode()).toBe('paused');
      expect(media.paused).toBe(true);
      send({ blocked: false, source: 'nested-map', restorePlayback: true });
      expect(engine.getMode()).toBe('playing');
      expect(media.paused).toBe(false);
    } finally { engine.stop(); }
  });

  it('preserves the manual continuation behavior of other overlays', async () => {
    const { engine, audio, media, send } = await playingLecture();
    try {
      send(openMap);
      send({ blocked: true, source: 'knowledge-lecture-tutor' });
      send(closeMap);
      send({ blocked: false, source: 'knowledge-lecture-tutor' });
      expect(engine.getMode()).toBe('paused');
      expect(media.paused).toBe(true);
      expect(audio.resume).not.toHaveBeenCalled();
    } finally { engine.stop(); }
  });

  it('guards restoration against an engine replacement, page change, hidden player or changed mode', () => {
    const engine = {};
    const original = { engine, sceneId: 'lecture', mode: 'playing' as const, active: true, audioPlaying: true };
    const opened = transitionPlaybackModalGate(createPlaybackModalGateState<object>(), openMap, original);
    for (const change of [
      { engine: {} }, { sceneId: 'next-page' }, { active: false }, { mode: 'idle' as const }, { mode: 'live' as const },
    ]) {
      const closed = transitionPlaybackModalGate(opened.state, closeMap, { ...original, mode: 'paused', ...change });
      expect(closed.resume).toBe(false);
      expect(closed.state.sources.size).toBe(0);
      expect(closed.state.restore).toBeNull();
    }
  });

  it('does not replace the original playing snapshot on a repeated block event', () => {
    const engine = {};
    const original = { engine, sceneId: 'lecture', mode: 'playing' as const, active: true, audioPlaying: true };
    const opened = transitionPlaybackModalGate(createPlaybackModalGateState<object>(), openMap, original);
    const repeated = transitionPlaybackModalGate(opened.state, openMap, { ...original, mode: 'paused', audioPlaying: false });
    const closed = transitionPlaybackModalGate(repeated.state, closeMap, { ...original, mode: 'paused', audioPlaying: false });
    expect(closed.resume).toBe(true);
    expect(closed.resumeAudio).toBe(true);
  });

  it('does not start idle or paused lectures or resume a live discussion automatically', () => {
    const engine = {};
    for (const mode of ['idle', 'paused', 'live'] as const) {
      const context = { engine, sceneId: 'lecture', mode, active: true, audioPlaying: false };
      const opened = transitionPlaybackModalGate(createPlaybackModalGateState<object>(), openMap, context);
      const closed = transitionPlaybackModalGate(opened.state, closeMap, { ...context, mode: 'paused' });
      expect(closed.resume).toBe(false);
      expect(closed.resumeAudio).toBe(false);
    }
  });
});
