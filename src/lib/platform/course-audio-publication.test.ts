import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechAction } from '@openmaic/lib/types/action';
import type { PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
import { createPblTemplateCourse, encodePblTemplate, type PblTemplateSnapshot } from './pbl-template';
import { computeCourseQualitySignature } from '@/lib/course-quality-review/signature';
import { hasAuthenticCourseAudioPublication } from '@/lib/course-quality-review/audio-publication';
import { summarizeTeachingTimingAudit } from '@/lib/openmaic/server/classroom-asset-generation';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { CourseMindMap } from '@/lib/course-mind-map/types';
import { computeCourseMindMapSourceFingerprint } from '@/lib/course-mind-map/source';
import { resolveCourseMindMapBindings } from '@/lib/course-mind-map/bindings';
import { validateCourseMindMap } from '@/lib/course-mind-map/generation';

const mocks = vi.hoisted(() => ({ root: '', read: vi.fn(), transaction: vi.fn(), lock: vi.fn(), rowLock: vi.fn(),
  template: vi.fn(), createVersion: vi.fn(), updateVersion: vi.fn(), updateTemplate: vi.fn(), updateInstance: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/openmaic/server/classroom-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/openmaic/server/classroom-storage')>(),
  get CLASSROOMS_DIR() { return mocks.root; },
  readClassroom: mocks.read,
}));
import { hashJson, publishCourseAudioVersion, type PublishCourseAudioInput } from './course-audio-publication';

const secret = 'course-audio-publication-test-secret-at-least-thirty-two';
const now = new Date('2026-10-14T00:00:00.000Z');
let source: PersistedClassroomData;
let candidate: PersistedClassroomData;
let snapshot: PblTemplateSnapshot;
let input: PublishCourseAudioInput;

function wav(seconds = 1): Buffer {
  const rate = 8000;
  const bytes = Buffer.alloc(44 + rate * 2 * seconds);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

async function bindAudio(speech: SpeechAction, seconds = 1): Promise<void> {
  const bytes = wav(seconds);
  const folder = path.join(mocks.root, candidate.id, 'audio');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${speech.id}.wav`), bytes);
  speech.audioUrl = `/api/openmaic/classroom-media/${candidate.id}/audio/${speech.id}.wav`;
  speech.audioId = `${speech.id}-new`;
  speech.audioDurationSec = seconds;
  speech.speechAlignment = { version: '1', status: 'aligned', textHash: createHash('sha256').update(speech.text).digest('hex'),
    audioHash: createHash('sha256').update(bytes).digest('hex'),
    spans: [{ text: speech.text, startChar: 0, endChar: speech.text.length, startMs: 0, endMs: seconds * 1000 }] };
}

function speech(sceneIndex = 0): SpeechAction {
  return candidate.scenes[sceneIndex]!.actions!.find((action): action is SpeechAction => action.type === 'speech' && Boolean(action.text.trim()))!;
}

function installSourceMap(): CourseMindMap {
  const course = createPblTemplateCourse('course', snapshot.design);
  const map = resolveCourseMindMapBindings({ schemaVersion: 1,
    sourceFingerprint: computeCourseMindMapSourceFingerprint(course, source.scenes), bindingFingerprint: '',
    rootId: 'root', nodes: [{ id: 'root', label: '教学理论', knowledgePointIds: [] },
      { id: 'concept', label: '核心概念', parentId: 'root', knowledgePointIds: [] },
      { id: 'meaning', label: '核心含义', parentId: 'concept', knowledgePointIds: [] }],
    relations: [], bindings: [{ sceneId: 'slide', defaultNodeId: 'concept',
      cues: [{ speechId: 'node-a', nodeId: 'meaning', anchor: { quote: '概念' } }] },
    { sceneId: 'quiz', defaultNodeId: 'concept', cues: [] }], diagnostics: [] }, source.scenes);
  map.diagnostics = validateCourseMindMap(map, course, source.scenes).issues;
  snapshot.design.content.courseMindMap = map;
  input.snapshot.design.content.courseMindMap = structuredClone(map);
  input.sourceSnapshotFingerprint = hashJson(snapshot);
  return map;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv('JWT_SECRET', secret);
  mocks.root = await mkdtemp(path.join(os.tmpdir(), 'coteach-course-audio-'));
  source = { id: 'source-classroom', revision: 5, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    stage: { id: 'source-classroom', name: '教学理论', createdAt: now.getTime(), updatedAt: now.getTime() },
    scenes: [
      { id: 'slide', outlineId: 'page-a', stageId: 'source-classroom', title: '认识概念', order: 0, type: 'slide',
        content: { type: 'slide', canvas: { id: 'fixed-canvas', elements: [{ id: 'term', type: 'text', content: '核心概念', left: 10, top: 10, width: 200, height: 60 }] } },
        actions: [{ id: 'node-a', type: 'speech', text: '概念：理解核心认识。', voice: 'Cherry', speed: 1,
          audioUrl: '/api/openmaic/classroom-media/source-classroom/audio/old.wav', audioDurationSec: 2 },
        { id: 'wait', type: 'speech', text: '' }],
      },
      { id: 'quiz', outlineId: 'page-q', stageId: 'source-classroom', title: '小测', order: 1, type: 'quiz',
        content: { type: 'quiz', questions: [{ id: 'question-a', type: 'single', question: '请选择正确的认识。',
          options: [{ label: '理解条件', value: 'A' }, { label: '忽略条件', value: 'B' }], answer: ['A'], analysis: '条件不可忽略。' }] },
        actions: [{ id: 'quiz-intro', type: 'speech', text: '小测：请选择。', quizNarrationPhase: 'intro', voice: 'Cherry', speed: 1 }],
      },
    ],
  } as PersistedClassroomData;
  const course = createPblTemplateCourse('course', { name: '教学理论', aiLearningClassroomId: source.id,
    content: { ...createPblTemplateCourse('unused').content, qualityReviewRequired: true, _openmaicClassroomId: source.id,
      _openmaicSceneOutlines: [{ id: 'page-a', title: '认识概念', keyPoints: ['固定的页面要点'] },
        { id: 'page-q', title: '小测', quizConfig: { questionCount: 1 } }],
      teachingBlueprint: { schemaVersion: 3, sections: [{ id: 'section-a', units: [{ id: 'unit-a',
        explanationNodes: [{ id: 'node-a', kind: 'concept', content: '概念：理解核心认识。', prerequisiteNodeIds: [], provenance: 'course-source', sourceBindings: [{ source: 'actual-textbook' }] }],
      }], pages: [{ id: 'page-a', keyPoints: ['固定的页面要点'] }] }] } as never,
      qualityReview: { signature: 'actual-old-report', issues: [{ title: '原报告保留' }] } as never,
    } });
  const review = { schemaVersion: 1 as const, courseId: course.id, classroomId: source.id,
    signature: computeCourseQualitySignature(course, source), teacherId: 'teacher', confirmedAt: now.toISOString(), acceptedIssueIds: [], manualContentReview: true };
  course.content.teacherReview = { ...review, seal: createHmac('sha256', secret).update(JSON.stringify([
    'course-teacher-review-v1', review.courseId, review.classroomId, review.signature, review.teacherId, review.confirmedAt,
    [], true,
  ])).digest('hex') };
  snapshot = encodePblTemplate(course);
  candidate = structuredClone(source);
  candidate.id = 'candidate-classroom'; candidate.revision = 1; candidate.stage.id = candidate.id;
  candidate.assetGeneration = { status: 'completed', completed: 2, requested: 2, failures: [], updatedAt: now.toISOString() };
  candidate.scenes.forEach((scene) => { scene.stageId = candidate.id; scene.narrationRevision = 'spoken-v2'; });
  speech().text = '同学们，我们先来理解这个概念。';
  speech(1).text = '请根据刚才的讲解选择正确的认识。';
  await bindAudio(speech()); await bindAudio(speech(1));
  const nextSnapshot = structuredClone(snapshot);
  nextSnapshot.design.aiLearningClassroomId = candidate.id; nextSnapshot.design.content._openmaicClassroomId = candidate.id;
  nextSnapshot.design.content.teachingBlueprint!.sections[0]!.units[0]!.explanationNodes![0]!.content = speech().text;
  nextSnapshot.design.content.teachingRevisionState = { schemaVersion: 1, changeType: 'narration', baseClassroomRevision: 5,
    classroomRevision: 1, affectedSceneIds: ['slide', 'quiz'], invalidated: [], updatedAt: now.toISOString() };
  nextSnapshot.design.content.teachingTimingAudit = summarizeTeachingTimingAudit({
    outlines: nextSnapshot.design.content._openmaicSceneOutlines as SceneOutline[], studentScenes: candidate.scenes, enableTTS: true,
  });
  input = { courseId: 'course', sourceVersionId: 'v3', sourceSnapshotFingerprint: hashJson(snapshot),
    expectedCourseUpdatedAt: now.toISOString(), sourceClassroom: source, candidate, snapshot: nextSnapshot };
  mocks.template.mockResolvedValue({ id: 'course', ownerId: 'teacher', status: 'ACTIVE', updatedAt: now,
    versions: [{ id: 'v3', version: 3, status: 'PUBLISHED', snapshot, mediaRefs: { unchanged: 'reference' } }] });
  mocks.read.mockImplementation(async (id: string) => id === source.id ? source : id === candidate.id ? candidate : null);
  mocks.createVersion.mockResolvedValue({ id: 'v4' });
  mocks.transaction.mockImplementation((fn) => fn({ $executeRaw: mocks.lock, $queryRaw: mocks.rowLock,
    classroomTemplate: { findUnique: mocks.template, update: mocks.updateTemplate },
    classroomTemplateVersion: { create: mocks.createVersion, update: mocks.updateVersion },
    classroomInstance: { update: mocks.updateInstance },
  }));
});

afterEach(async () => { await rm(mocks.root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('authorized course audio publication', () => {
  it('creates an immutable published version, preserves old review evidence and existing classroom instances', async () => {
    const beforeInput = structuredClone(input);
    const result = await publishCourseAudioVersion(input);
    expect(result).toMatchObject({ version: 4, versionId: 'v4', classroomId: candidate.id });
    expect(result.courseVersion).toBeGreaterThan(now.getTime());
    const data = mocks.createVersion.mock.calls[0]![0].data;
    expect(data).toMatchObject({ templateId: 'course', version: 4, status: 'PUBLISHED', mediaRefs: { unchanged: 'reference' } });
    expect(data.snapshot.design.content.teacherReview).toEqual(snapshot.design.content.teacherReview);
    expect(data.snapshot.design.content.qualityReview).toEqual(snapshot.design.content.qualityReview);
    expect(data.snapshot.design.content._openmaicSceneOutlines).toEqual(snapshot.design.content._openmaicSceneOutlines);
    const updatedCourse = createPblTemplateCourse('course', data.snapshot.design);
    expect(hasAuthenticCourseAudioPublication(updatedCourse, candidate, 'teacher')).toBe(true);
    expect(mocks.updateVersion).not.toHaveBeenCalled(); expect(mocks.updateInstance).not.toHaveBeenCalled();
    expect(mocks.updateTemplate).toHaveBeenCalledWith({ where: { id: 'course' }, data: { updatedAt: expect.any(Date) } });
    expect(input).toEqual(beforeInput);
    const advisory = mocks.lock.mock.calls[0]![0].join(' ');
    expect(advisory).toContain('pg_advisory_xact_lock');
    expect(mocks.lock.mock.calls[0]![1]).toBe('pbl-template:course');
    expect(mocks.rowLock.mock.calls[0]![0].join(' ')).toContain('FOR UPDATE');
  });

  it('applies an explicit course name to the template, snapshot and classroom while preserving the source review', async () => {
    input.courseName = '教学理论课程';
    input.snapshot.design.name = input.courseName;
    candidate.stage.name = input.courseName;
    const beforeSource = structuredClone(snapshot);
    await publishCourseAudioVersion(input);
    const published = mocks.createVersion.mock.calls[0]![0].data.snapshot as PblTemplateSnapshot;
    expect(published.design.name).toBe(input.courseName);
    expect(published.design.content.teacherReview).toEqual(snapshot.design.content.teacherReview);
    expect(hasAuthenticCourseAudioPublication(createPblTemplateCourse('course', published.design), candidate, 'teacher')).toBe(true);
    expect(mocks.updateTemplate).toHaveBeenCalledWith({ where: { id: 'course' }, data: {
      updatedAt: expect.any(Date), title: input.courseName,
    } });
    expect(snapshot).toEqual(beforeSource);
  });

  it.each(['unrequested', 'snapshot', 'classroom', 'empty'] as const)('rejects an inconsistent course name: %s', async (change) => {
    input.courseName = '教学理论课程';
    input.snapshot.design.name = input.courseName;
    candidate.stage.name = input.courseName;
    if (change === 'unrequested') delete input.courseName;
    if (change === 'snapshot') input.snapshot.design.name = '另一个名称';
    if (change === 'classroom') candidate.stage.name = '另一个名称';
    if (change === 'empty') input.courseName = '  ';
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({
      code: change === 'empty' ? 'INVALID_COURSE_NAME' : 'AUDIO_CONTENT_CHANGED',
    });
    expect(mocks.createVersion).not.toHaveBeenCalled();
    expect(mocks.updateTemplate).not.toHaveBeenCalled();
  });

  it.each(['version', 'updatedAt', 'snapshot'] as const)('rejects a concurrent change to %s before any database write', async (field) => {
    if (field === 'version') input.sourceVersionId = 'older-version';
    if (field === 'updatedAt') input.expectedCourseUpdatedAt = new Date(now.getTime() - 1).toISOString();
    if (field === 'snapshot') input.sourceSnapshotFingerprint = 'wrong-hash';
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(mocks.createVersion).not.toHaveBeenCalled(); expect(mocks.updateTemplate).not.toHaveBeenCalled();
  });

  it('rejects a changed source classroom revision and an unsaved candidate', async () => {
    mocks.read.mockImplementation(async (id: string) => id === source.id ? { ...source, revision: 6 } : candidate);
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'CLASSROOM_CONFLICT' });
    mocks.read.mockImplementation(async (id: string) => id === source.id ? source : null);
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'CANDIDATE_CONFLICT' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it.each(['ppt', 'quiz', 'order', 'action', 'empty-speech'] as const)('rejects changes to fixed %s content', async (change) => {
    if (change === 'ppt' && candidate.scenes[0]!.content.type === 'slide') candidate.scenes[0]!.content.canvas.elements = [];
    if (change === 'quiz' && candidate.scenes[1]!.content.type === 'quiz') candidate.scenes[1]!.content.questions[0]!.analysis = '被改动的解析';
    if (change === 'order') candidate.scenes.reverse();
    if (change === 'action') candidate.scenes[0]!.actions!.push({ id: 'new-board', type: 'wb_open' });
    if (change === 'empty-speech') candidate.scenes[0]!.actions!.pop();
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_CONTENT_CHANGED' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(['review', 'outline', 'source-binding', 'node-removal'] as const)('rejects changes to authoritative %s metadata', async (change) => {
    if (change === 'review') input.snapshot.design.content.teacherReview!.confirmedAt = '2030-01-01';
    if (change === 'outline') input.snapshot.design.content._openmaicSceneOutlines![0]!.title = '新标题';
    const unit = input.snapshot.design.content.teachingBlueprint!.sections[0]!.units[0]!;
    if (change === 'source-binding') unit.explanationNodes![0]!.sourceBindings = [];
    if (change === 'node-removal') unit.explanationNodes = [];
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_CONTENT_CHANGED' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it.each(['old-url', 'missing', 'duration', 'text-hash', 'audio-hash', 'span', 'span-gap'] as const)('rejects incomplete or stale audio: %s', async (change) => {
    const action = speech();
    if (change === 'old-url') action.audioUrl = '/api/openmaic/classroom-media/source-classroom/audio/old.wav';
    if (change === 'missing') await rm(path.join(mocks.root, candidate.id, 'audio', `${action.id}.wav`));
    if (change === 'duration') action.audioDurationSec = 50;
    if (change === 'text-hash') action.speechAlignment!.textHash = 'old';
    if (change === 'audio-hash') action.speechAlignment!.audioHash = 'old';
    if (change === 'span') action.speechAlignment!.spans[0]!.text = '旧的词句';
    if (change === 'span-gap') action.speechAlignment!.spans = [{ text: action.text.slice(0, 3), startChar: 0, endChar: 3, startMs: 0, endMs: 500 }];
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_NOT_READY' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('accepts calibrated visual anchors and rejects guessed offsets, stale anchors, and missing slide targets', async () => {
    const cue = { id: 'new-cue', type: 'spotlight' as const, elementId: 'term', speechId: speech().id,
      speechAnchor: { quote: '理解这个概念' }, speechOffsetMs: 0 };
    candidate.scenes[0]!.actions!.unshift(cue);
    await expect(publishCourseAudioVersion(input)).resolves.toMatchObject({ version: 4 });
    cue.speechOffsetMs = 200;
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_ANCHOR_INVALID' });
    cue.speechOffsetMs = 0; cue.speechAnchor.quote = '原讲稿的旧词句';
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_ANCHOR_INVALID' });
    cue.speechAnchor.quote = '理解这个概念'; cue.elementId = 'missing-element';
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_ANCHOR_INVALID' });
  });

  it('supports TTS paragraph splits while retaining segment identity, empty waits and binding to the new clips', async () => {
    const originalSpeech = speech();
    const first = { ...structuredClone(originalSpeech), id: `${originalSpeech.id}_tts_1`, text: '我们先来理解这个概念。' };
    const second = { ...structuredClone(originalSpeech), id: `${originalSpeech.id}_tts_2`, text: '接着再看它的适用条件。' };
    await bindAudio(first); await bindAudio(second);
    candidate.scenes[0]!.actions = [first, { id: 'split-cue', type: 'spotlight', elementId: 'term', speechId: second.id,
      speechAnchor: { quote: '适用条件' }, speechOffsetMs: 0 }, second, source.scenes[0]!.actions![1]!];
    input.snapshot.design.content.teachingBlueprint!.sections[0]!.units[0]!.explanationNodes![0]!.content = first.text + second.text;
    input.snapshot.design.content.teachingTimingAudit = summarizeTeachingTimingAudit({
      outlines: input.snapshot.design.content._openmaicSceneOutlines as SceneOutline[], studentScenes: candidate.scenes, enableTTS: true,
    });
    await expect(publishCourseAudioVersion(input)).resolves.toMatchObject({ version: 4 });
    second.speed = 1.5;
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_CONTENT_CHANGED' });
  });

  it('rejects a visual cue whose valid end anchor occurs before its start', async () => {
    const action = speech();
    action.speechAlignment!.spans = [...action.text].map((text, index) => ({ text, startChar: index, endChar: index + 1,
      startMs: index * 40, endMs: (index + 1) * 40 }));
    candidate.scenes[0]!.actions!.unshift({ id: 'reverse-cue', type: 'spotlight', elementId: 'term', speechId: action.id,
      speechAnchor: { quote: '理解这个概念' }, speechOffsetMs: action.text.indexOf('理解这个概念') * 40,
      endSpeechAnchor: { quote: '同学们' }, endSpeechOffsetMs: 120 });
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_ANCHOR_INVALID' });
  });

  it('refuses to issue an operational receipt for an unauthentic source review or another teacher', async () => {
    snapshot.design.content.teacherReview!.seal = 'f'.repeat(64);
    input.snapshot.design.content.teacherReview!.seal = 'f'.repeat(64);
    input.sourceSnapshotFingerprint = hashJson(snapshot);
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'TEACHER_REVIEW_REQUIRED' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it('rejects a stale authoritative manuscript and a fabricated actual-audio summary', async () => {
    const node = input.snapshot.design.content.teachingBlueprint!.sections[0]!.units[0]!.explanationNodes![0]!;
    node.content = '旧的讲稿内容';
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'MANUSCRIPT_CONFLICT' });
    node.content = speech().text;
    input.snapshot.design.content.teachingTimingAudit!.substantiveTeachingDurationSec = 999;
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_CONTENT_CHANGED' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it('keeps concept structure and independently rebinds an existing map to the new audio', async () => {
    const sourceMap = installSourceMap();
    const preserved = structuredClone(sourceMap);
    input.snapshot.design.content.courseMindMap!.bindings[0]!.cues[0]!.startMs = 999_000;
    await publishCourseAudioVersion(input);
    const published = mocks.createVersion.mock.calls[0]![0].data.snapshot as PblTemplateSnapshot;
    const rebound = published.design.content.courseMindMap!;
    expect(rebound).toMatchObject({ rootId: sourceMap.rootId, nodes: sourceMap.nodes, relations: sourceMap.relations,
      sourceFingerprint: sourceMap.sourceFingerprint });
    expect(rebound.bindings).toEqual(resolveCourseMindMapBindings(sourceMap, candidate.scenes).bindings);
    expect(rebound.bindingFingerprint).not.toBe(sourceMap.bindingFingerprint);
    expect(rebound.bindings[0]!.cues[0]).toMatchObject({ startMs: 0, speechTextHash: speech().speechAlignment!.textHash,
      audioHash: speech().speechAlignment!.audioHash });
    expect(sourceMap).toEqual(preserved);
    expect(hasAuthenticCourseAudioPublication(createPblTemplateCourse('course', published.design), candidate, 'teacher')).toBe(true);
  });

  it.each(['concept', 'relation', 'root', 'source', 'diagnostics', 'removal'] as const)('refuses external map %s changes during an audio update', async (change) => {
    installSourceMap();
    const map = input.snapshot.design.content.courseMindMap!;
    if (change === 'concept') map.nodes[1]!.label = '另一概念';
    if (change === 'relation') map.relations.push({ id: 'new', source: 'concept', target: 'meaning', label: '支撑', rationale: '外部新增' });
    if (change === 'root') map.rootId = 'concept';
    if (change === 'source') map.sourceFingerprint = 'different-source';
    if (change === 'diagnostics') map.diagnostics = [];
    if (change === 'removal') delete input.snapshot.design.content.courseMindMap;
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_CONTENT_CHANGED' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it('refuses to add an externally supplied concept map where the source had none', async () => {
    installSourceMap();
    delete snapshot.design.content.courseMindMap;
    input.sourceSnapshotFingerprint = hashJson(snapshot);
    await expect(publishCourseAudioVersion(input)).rejects.toMatchObject({ code: 'AUDIO_CONTENT_CHANGED' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });
});
