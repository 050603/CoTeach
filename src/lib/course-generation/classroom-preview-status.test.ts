import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { classroomPreviewStatus } from './classroom-preview-status';
import type { PersistedClassroomData } from '@openmaic/lib/server/classroom-storage';

function classroom(audioUrl?: string): Pick<PersistedClassroomData, 'scenes' | 'assetGeneration'> {
  return { scenes: [{ id: 'page', actions: [{ id: 'speech', type: 'speech', text: '讲解', ...(audioUrl ? { audioUrl } : {}) }] }] } as Pick<PersistedClassroomData, 'scenes'>;
}

describe('canonical classroom preview media status', () => {
  it('reads legacy audio-complete classrooms as ready without polling', () => {
    expect(classroomPreviewStatus(classroom('/audio.mp3'))).toMatchObject({ active: false, scenes: { page: { status: 'ready' } } });
  });

  it('does not poll forever for legacy incomplete audio without an active asset operation', () => {
    expect(classroomPreviewStatus(classroom())).toMatchObject({ active: false, scenes: { page: { status: 'failed' } } });
  });

  it('polls a running asset operation and exposes its failure without losing successful pages', () => {
    const input = classroom();
    input.assetGeneration = { status: 'running', requested: 1, completed: 0, failures: [], updatedAt: new Date().toISOString() };
    expect(classroomPreviewStatus(input)).toMatchObject({ active: true, scenes: { page: { status: 'preparing' } } });
    input.assetGeneration.status = 'partial-failure';
    input.assetGeneration.failures = [{ type: 'tts', elementId: 'tts-batch', error: '合成服务暂不可用' }];
    expect(classroomPreviewStatus(input)).toMatchObject({ active: false, scenes: { page: { status: 'failed', error: '合成服务暂不可用' } } });
  });

  it('changes content version when a same-ID speech receives durable audio', () => {
    expect(classroomPreviewStatus(classroom()).contentVersion).not.toBe(classroomPreviewStatus(classroom('/audio.mp3')).contentVersion);
  });

  it('waits for phrase-timed teaching actions even when narration audio is already present', () => {
    const input = classroom('/audio.mp3');
    input.scenes[0].actions!.unshift({ id: 'cue', type: 'spotlight', elementId: 'target', speechId: 'speech', speechAnchor: { quote: '讲解' } });
    expect(classroomPreviewStatus(input, { active: true, status: 'running' })).toMatchObject({
      scenes: { page: { status: 'preparing', phase: 'alignment' } },
    });
    expect(classroomPreviewStatus(input)).toMatchObject({ scenes: { page: { status: 'failed', phase: 'alignment' } } });
    const speech = input.scenes[0].actions!.find((action) => action.type === 'speech')!;
    if (speech.type !== 'speech') throw new Error('Missing speech fixture');
    speech.speechAlignment = {
      version: 'test', status: 'aligned', audioHash: 'audio-bytes-hash',
      textHash: createHash('sha256').update(speech.text).digest('hex'),
      spans: [{ text: '讲解', startChar: 0, endChar: 2, startMs: 0, endMs: 500 }],
    };
    expect(classroomPreviewStatus(input)).toMatchObject({ scenes: { page: { status: 'ready' } } });
    speech.speechAlignment.textHash = 'stale-narration';
    expect(classroomPreviewStatus(input)).toMatchObject({ scenes: { page: { status: 'failed', phase: 'alignment' } } });
    speech.speechAlignment.textHash = createHash('sha256').update(speech.text).digest('hex');
    speech.speechAlignment.spans[0].endChar = 1;
    expect(classroomPreviewStatus(input)).toMatchObject({ scenes: { page: { status: 'failed', phase: 'alignment' } } });
    speech.speechAlignment.status = 'failed';
    speech.speechAlignment.error = '对齐服务暂时不可用';
    expect(classroomPreviewStatus(input, { active: true, status: 'running' })).toMatchObject({
      scenes: { page: { status: 'failed', phase: 'alignment', error: '对齐服务暂时不可用' } },
    });
  });

  it.each(['waypoint', 'end-anchor'] as const)('also waits for a %s without a primary start anchor', (kind) => {
    const input = classroom('/audio.mp3');
    input.scenes[0].actions!.unshift({ id: 'cue', type: 'laser', elementId: 'target', speechId: 'speech',
      ...(kind === 'waypoint'
        ? { waypoints: [{ elementId: 'other-target', speechAnchor: { quote: '讲解' } }] }
        : { endSpeechAnchor: { quote: '讲解' } }),
    });
    expect(classroomPreviewStatus(input, { active: true, status: 'running' })).toMatchObject({
      scenes: { page: { status: 'preparing', phase: 'alignment' } },
    });
  });

  it('keeps legacy untimed visual cues and plain audio playable without alignment', () => {
    const input = classroom('/audio.mp3');
    input.scenes[0].actions!.unshift({ id: 'cue', type: 'laser', elementId: 'target', speechId: 'speech', speechOffsetMs: 0 });
    expect(classroomPreviewStatus(input)).toMatchObject({ scenes: { page: { status: 'ready' } } });
  });

  it('accepts real forced alignment that omits surrounding punctuation tokens', () => {
    const input = classroom('/audio.mp3');
    const speech = input.scenes[0].actions![0];
    if (speech.type !== 'speech') throw new Error('Missing speech fixture');
    speech.text = '“讲解”。';
    speech.speechAlignment = {
      version: 'test', status: 'aligned', audioHash: 'audio-bytes-hash',
      textHash: createHash('sha256').update(speech.text).digest('hex'),
      spans: [{ text: '讲解', startChar: 1, endChar: 3, startMs: 0, endMs: 500 }],
    };
    input.scenes[0].actions!.unshift({ id: 'cue', type: 'spotlight', elementId: 'target', speechId: 'speech', speechAnchor: { quote: '“讲解”。' } });
    expect(classroomPreviewStatus(input)).toMatchObject({ scenes: { page: { status: 'ready' } } });
  });
});
