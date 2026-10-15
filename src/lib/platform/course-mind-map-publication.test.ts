import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedClassroomData } from '@/lib/openmaic/server/classroom-storage';
import { normalizePersistedClassroom } from '@/lib/openmaic/server/classroom-storage';
import type { CourseMindMap } from '@/lib/course-mind-map/types';
import { computeCourseMindMapSourceFingerprint } from '@/lib/course-mind-map/source';
import { resolveCourseMindMapBindings } from '@/lib/course-mind-map/bindings';
import { validateCourseMindMap } from '@/lib/course-mind-map/generation';
import { hashJson } from '@/lib/course-quality-review/audio-publication';
import { createPblTemplateCourse, encodePblTemplate, type PblTemplateSnapshot } from './pbl-template';

const mocks = vi.hoisted(() => ({ read: vi.fn(), transaction: vi.fn(), lock: vi.fn(), rowLock: vi.fn(),
  template: vi.fn(), sourceVersion: vi.fn(), createVersion: vi.fn(), updateVersion: vi.fn(), updateTemplate: vi.fn(), updateInstance: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { $transaction: mocks.transaction, classroomTemplate: { findUnique: mocks.template } } }));
vi.mock('@/lib/db/transaction-retry', () => ({ runMutationTransaction: mocks.transaction }));
vi.mock('@/lib/openmaic/server/classroom-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/openmaic/server/classroom-storage')>(), readClassroom: mocks.read,
}));
import { publishCourseMindMapVersion, readCourseMindMapPublicationSource, type PublishCourseMindMapInput } from './course-mind-map-publication';

const now = new Date('2026-10-14T00:00:00.000Z');
let classroom: PersistedClassroomData;
let snapshot: PblTemplateSnapshot;
let input: PublishCourseMindMapInput;
let template: { id: string; status: string; updatedAt: Date; versions: Array<{
  id: string; templateId: string; version: number; status: string; snapshot: PblTemplateSnapshot; mediaRefs: unknown;
}> };
const map = () => input.snapshot.design.content.courseMindMap!;

beforeEach(() => {
  vi.resetAllMocks();
  const text = '抛锚式教学法以真实问题为锚，强调情境性。';
  classroom = { id: 'classroom', revision: 7, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    stage: { id: 'classroom', name: '教学理论', createdAt: now.getTime(), updatedAt: now.getTime() },
    scenes: [{ id: 'scene', stageId: 'classroom', title: '抛锚式教学法的特征', order: 0, type: 'slide', knowledgePointIds: ['kp'],
      content: { type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: 16 / 9,
        theme: { backgroundColor: '#ffffff', themeColors: [], fontColor: '#000000', fontName: 'Arial' }, elements: [] } },
      actions: [{ id: 'speech', type: 'speech', text, audioUrl: '/api/openmaic/classroom-media/classroom/audio/speech.wav',
        speechAlignment: { version: '1', status: 'aligned', textHash: createHash('sha256').update(text).digest('hex'),
          audioHash: 'a'.repeat(64), spans: [...text].map((char, index) => ({ text: char, startChar: index, endChar: index + 1,
            startMs: index * 100, endMs: (index + 1) * 100 })) } }],
    }],
  };
  const course = createPblTemplateCourse('course', { name: '教学理论', aiLearningClassroomId: classroom.id,
    content: { ...createPblTemplateCourse('unused').content, _openmaicClassroomId: classroom.id,
      knowledgePoints: [{ id: 'kp', name: '抛锚式教学法的特征', description: '以真实问题为锚，强调情境性。' }],
      teacherReview: { schemaVersion: 1, courseId: 'course', classroomId: classroom.id, signature: 'original-teaching-signature',
        teacherId: 'teacher', confirmedAt: now.toISOString(), acceptedIssueIds: [], seal: 'original-review-seal' },
      teachingBlueprint: { schemaVersion: 3, sections: [{ id: 'section', units: [], pages: [] }] } as never,
      teachingRevisionState: { schemaVersion: 1, baseClassroomRevision: 6, classroomRevision: 7, changeType: 'narration',
        affectedSceneIds: ['scene'], invalidated: [], updatedAt: now.toISOString(), audioPublication: { seal: 'original-audio-receipt' } as never },
    } });
  snapshot = encodePblTemplate(course);
  const candidateMap: CourseMindMap = { schemaVersion: 1, sourceFingerprint: computeCourseMindMapSourceFingerprint(course, classroom.scenes),
    bindingFingerprint: '', rootId: 'root',
    nodes: [{ id: 'root', label: '教学理论', knowledgePointIds: [] },
      { id: 'method', label: '抛锚式教学法', parentId: 'root', knowledgePointIds: ['kp'] },
      { id: 'situated', label: '情境性', parentId: 'method', knowledgePointIds: ['kp'] }],
    relations: [], bindings: [{ sceneId: 'scene', defaultNodeId: 'method',
      cues: [{ speechId: 'speech', nodeId: 'situated', anchor: { quote: '情境性' } }] }], diagnostics: [] };
  const candidate = structuredClone(snapshot);
  candidate.design.content.courseMindMap = resolveCourseMindMapBindings(candidateMap, classroom.scenes);
  input = { courseId: 'course', sourceVersion: 4, sourceVersionId: 'v4', sourceSnapshotFingerprint: hashJson(snapshot),
    expectedCourseUpdatedAt: now.toISOString(), sourceClassroomFingerprint: hashJson(classroom),
    sourceClassroom: structuredClone(classroom), snapshot: candidate };
  template = { id: 'course', status: 'ACTIVE', updatedAt: now, versions: [{ id: 'v4', templateId: 'course',
    version: 4, status: 'PUBLISHED', snapshot, mediaRefs: { unchanged: 'media' } }] };
  mocks.template.mockImplementation(async () => template);
  mocks.read.mockImplementation(async (id: string) => id === classroom.id ? classroom : null);
  mocks.sourceVersion.mockResolvedValue(template.versions[0]);
  mocks.createVersion.mockResolvedValue({ id: 'v5' });
  mocks.transaction.mockImplementation((operation) => operation({ $executeRaw: mocks.lock, $queryRaw: mocks.rowLock,
    classroomTemplate: { findUnique: mocks.template, update: mocks.updateTemplate },
    classroomTemplateVersion: { findUnique: mocks.sourceVersion, create: mocks.createVersion, update: mocks.updateVersion },
    classroomInstance: { update: mocks.updateInstance },
  }));
});

describe('authorized concept-map publication', () => {
  it('captures the latest publication using the same normalization as classroom readers', async () => {
    const speech = classroom.scenes[0]!.actions![0]!;
    if (speech.type === 'speech') speech.audioUrl = 'https://old-host.test/api/openmaic/classroom-media/classroom/audio/speech.wav';
    const source = await readCourseMindMapPublicationSource('course', 4);
    expect(source).toMatchObject({ sourceVersion: 4, sourceVersionId: 'v4', expectedCourseUpdatedAt: now.toISOString(),
      sourceSnapshotFingerprint: hashJson(snapshot), sourceClassroomFingerprint: hashJson(normalizePersistedClassroom(classroom)) });
    expect(source.sourceClassroom.scenes[0]!.actions![0]).toMatchObject({ audioUrl: '/api/openmaic/classroom-media/classroom/audio/speech.wav' });
    expect(source.snapshot).toEqual(snapshot);
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it('creates an immutable publication containing only the new map and keeps old review, audio and instances', async () => {
    const savedInput = structuredClone(input);
    const result = await publishCourseMindMapVersion(input);
    expect(result).toMatchObject({ version: 5, versionId: 'v5', classroomId: classroom.id, reused: false });
    expect(result.courseVersion).toBeGreaterThan(now.getTime());
    const data = mocks.createVersion.mock.calls[0]![0].data;
    expect(data).toMatchObject({ templateId: 'course', version: 5, status: 'PUBLISHED', mediaRefs: { unchanged: 'media' } });
    const published = structuredClone(data.snapshot) as PblTemplateSnapshot;
    expect(published.design.content.courseMindMap).toEqual(map());
    delete published.design.content.courseMindMap;
    expect(published).toEqual(snapshot);
    expect(mocks.updateVersion).not.toHaveBeenCalled(); expect(mocks.updateInstance).not.toHaveBeenCalled();
    expect(mocks.updateTemplate).toHaveBeenCalledWith({ where: { id: 'course' }, data: { updatedAt: expect.any(Date) } });
    expect(mocks.lock.mock.calls[0]![0].join('')).toContain('pg_advisory_xact_lock');
    expect(mocks.lock.mock.calls[0]![1]).toBe('pbl-template:course');
    expect(mocks.rowLock.mock.calls[0]![0].join('')).toContain('FOR UPDATE');
    expect(input).toEqual(savedInput);
  });

  it.each(['versionId', 'version', 'updatedAt', 'snapshot'] as const)('rejects changed source %s before publishing', async (field) => {
    if (field === 'versionId') input.sourceVersionId = 'earlier-version';
    if (field === 'version') input.sourceVersion = 3;
    if (field === 'updatedAt') input.expectedCourseUpdatedAt = new Date(now.getTime() - 1).toISOString();
    if (field === 'snapshot') input.sourceSnapshotFingerprint = 'different-snapshot';
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(mocks.createVersion).not.toHaveBeenCalled(); expect(mocks.updateTemplate).not.toHaveBeenCalled();
  });

  it('rejects changed classroom data both in the saved input and on the reader', async () => {
    input.sourceClassroom.revision = 8;
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'CLASSROOM_CONFLICT' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    input.sourceClassroom = structuredClone(classroom);
    classroom.revision = 8;
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'CLASSROOM_CONFLICT' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it.each(['name', 'review', 'audio-receipt', 'blueprint', 'classroom'] as const)('refuses to change fixed %s data', async (field) => {
    if (field === 'name') input.snapshot.design.name = '新的课程';
    if (field === 'review') input.snapshot.design.content.teacherReview!.seal = 'new-review';
    if (field === 'audio-receipt') input.snapshot.design.content.teachingRevisionState!.audioPublication!.seal = 'new-audio-proof';
    if (field === 'blueprint') input.snapshot.design.content.teachingBlueprint!.sections[0]!.id = 'new-section';
    if (field === 'classroom') input.snapshot.design.aiLearningClassroomId = 'new-classroom';
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'MIND_MAP_CONTENT_CHANGED' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it('rejects mismatching concept and audio fingerprints', async () => {
    const originalSource = map().sourceFingerprint;
    map().sourceFingerprint = 'stale-concepts';
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'MIND_MAP_SOURCE_CONFLICT' });
    map().sourceFingerprint = originalSource; map().bindingFingerprint = 'stale-audio';
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'MIND_MAP_BINDING_CONFLICT' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it('rejects disconnected nodes and forged audio timings', async () => {
    map().nodes[2]!.parentId = 'missing-parent';
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'INVALID_MIND_MAP_CANDIDATE' });
    map().nodes[2]!.parentId = 'method'; map().bindings[0]!.cues[0]!.startMs = 999_000;
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'INVALID_MIND_MAP_CANDIDATE' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it('keeps unresolved quality diagnoses without presenting them as passed', async () => {
    map().nodes[1]!.label = '这是仍然需要后续教师优化的特别冗长完整概念标题。';
    const course = createPblTemplateCourse('course', snapshot.design);
    map().diagnostics = validateCourseMindMap(map(), course, classroom.scenes).issues;
    expect(map().diagnostics.length).toBeGreaterThan(0);
    await expect(publishCourseMindMapVersion(input)).resolves.toMatchObject({ version: 5 });
    expect(mocks.createVersion.mock.calls[0]![0].data.snapshot.design.content.courseMindMap.diagnostics).toEqual(map().diagnostics);
  });

  it('refuses a candidate that hides its actual quality diagnostics', async () => {
    map().nodes[1]!.label = '这是仍然需要后续教师优化的特别冗长完整概念标题。';
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'INVALID_MIND_MAP_CANDIDATE' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it('rejects a missing diagnostics contract even when the candidate has no quality issues', async () => {
    map().diagnostics = undefined as never;
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'INVALID_MIND_MAP_CANDIDATE' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });

  it('replays an identical candidate without another version and rejects a changed replay', async () => {
    const first = await publishCourseMindMapVersion(input);
    template.updatedAt = new Date(first.courseVersion);
    template.versions = [{ id: 'v5', templateId: 'course', version: 5, status: 'PUBLISHED',
      snapshot: structuredClone(input.snapshot), mediaRefs: { unchanged: 'media' } }];
    mocks.createVersion.mockClear(); mocks.updateTemplate.mockClear();
    await expect(publishCourseMindMapVersion(input)).resolves.toEqual({ ...first, reused: true });
    expect(mocks.createVersion).not.toHaveBeenCalled(); expect(mocks.updateTemplate).not.toHaveBeenCalled();
    map().nodes[1]!.description = '另一份候选';
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('rejects a missing map and refuses snapshots of older or unfinished sources', async () => {
    delete input.snapshot.design.content.courseMindMap;
    await expect(publishCourseMindMapVersion(input)).rejects.toMatchObject({ code: 'INVALID_MIND_MAP_CANDIDATE' });
    await expect(readCourseMindMapPublicationSource('course', 3)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    classroom.assetGeneration = { status: 'running', requested: 1, completed: 0, failures: [], updatedAt: now.toISOString() };
    await expect(readCourseMindMapPublicationSource('course', 4)).rejects.toMatchObject({ code: 'CLASSROOM_NOT_READY' });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });
});
