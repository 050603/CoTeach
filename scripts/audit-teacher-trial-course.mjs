// Read-only preflight for the exact classroom handed to a trial teacher.
// Run with TRIAL_OFFERING_ID and TRIAL_ACTIVITY_ID. No account data is printed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';

const offeringId = process.env.TRIAL_OFFERING_ID;
const activityId = process.env.TRIAL_ACTIVITY_ID;
if (!offeringId || !activityId) throw new Error('Set TRIAL_OFFERING_ID and TRIAL_ACTIVITY_ID.');
const secretFile = process.env.TRIAL_DATABASE_URL_FILE || 'deploy/secrets/database_url.txt';
process.env.DATABASE_URL = readFileSync(secretFile, 'utf8').trim();
const classroomDir = path.resolve(process.env.CLASSROOM_DATA_DIR || '.openpbl-data/classrooms');
const uploadDir = path.resolve(process.env.UPLOAD_DIR || '.openpbl-data/uploads');
const output = path.resolve(process.env.TRIAL_OUTPUT_DIR || 'test-results/teacher-trial/course-preflight');
mkdirSync(output, { recursive: true });
const db = new PrismaClient();
const checks = [];
const check = (name, condition, detail = '') => checks.push({ name, status: condition ? '通过' : '失败', detail });

function collectMedia(value, paths = new Set()) {
  if (Array.isArray(value)) value.forEach(item => collectMedia(item, paths));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['src', 'poster', 'audioUrl'].includes(key) && typeof item === 'string') paths.add(item.split('?')[0]);
      if (item && typeof item === 'object') collectMedia(item, paths);
    }
  }
  return [...paths];
}

function wavDuration(file) {
  const bytes = readFileSync(file);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'fmt ' && size >= 16) byteRate = bytes.readUInt32LE(offset + 16);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') dataSize = size;
    offset += 8 + size + (size % 2);
  }
  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
}

try {
  const offering = await db.courseOffering.findUniqueOrThrow({
    where: { id: offeringId }, select: { name: true, status: true },
  });
  const activity = await db.activity.findUniqueOrThrow({
    where: { id: activityId },
    select: { title: true, type: true, isOpen: true, archivedAt: true,
      chapter: { select: { offeringId: true, isOpen: true } },
      classroomInstances: { orderBy: { runNo: 'desc' }, select: {
        id: true, status: true, endedAt: true, templateVersion: { select: {
          version: true, status: true, snapshot: true, template: { select: { ownerId: true } },
        } },
      } },
    },
  });
  const instance = activity.classroomInstances.find(item => item.status.toLowerCase() === 'teaching')
    || activity.classroomInstances[0];
  check('course-and-activity-open', offering.status.toLowerCase() === 'open'
    && activity.chapter.offeringId === offeringId && activity.chapter.isOpen && activity.isOpen && !activity.archivedAt
    && activity.type.toLowerCase() === 'classroom');
  check('classroom-instance-teaching', !!instance && instance.status.toLowerCase() === 'teaching');
  check('published-classroom-version', instance?.templateVersion.status.toLowerCase() === 'published');

  const snapshot = instance?.templateVersion.snapshot;
  const classroomId = snapshot?.design?.aiLearningClassroomId;
  assert.match(classroomId || '', /^[a-zA-Z0-9_-]+$/, 'No bound student lecture classroom');
  const classroomFile = path.join(classroomDir, `${classroomId}.json`);
  const classroom = JSON.parse(readFileSync(classroomFile, 'utf8'));
  const scenes = classroom.scenes || [];
  const slides = scenes.filter(scene => scene.type === 'slide');
  const quizzes = scenes.filter(scene => scene.type === 'quiz');
  const speech = scenes.flatMap(scene => scene.actions || []).filter(action => action.type === 'speech');
  const missingSlideAudio = slides.filter(scene => !(scene.actions || []).some(action => action.type === 'speech' && action.audioUrl));
  check('student-scene-contract', scenes.length > 0 && scenes.every(scene =>
    scene.stageKey === 'ai-learning' && scene.audience === 'student' && scene.generationPurpose === 'knowledge-teaching'),
  `${scenes.length} scenes, ${slides.length} slides, ${quizzes.length} quizzes`);
  check('delivered-lecture-scene-types', slides.length + quizzes.length === scenes.length,
    `${slides.length} slides, ${quizzes.length} quizzes, ${scenes.length - slides.length - quizzes.length} other`);
  check('all-slides-have-narration', missingSlideAudio.length === 0, `${missingSlideAudio.length} missing`);

  const media = collectMedia(scenes).filter(url => url.startsWith(`/api/openmaic/classroom-media/${classroomId}/`));
  const missingMedia = media.filter(url => {
    const relative = url.slice(`/api/openmaic/classroom-media/${classroomId}/`.length);
    const file = path.resolve(classroomDir, classroomId, relative);
    return !file.startsWith(`${path.resolve(classroomDir, classroomId)}${path.sep}`)
      || !existsSync(file) || statSync(file).size === 0;
  });
  check('referenced-classroom-media-present', missingMedia.length === 0,
    `${media.length} references; ${missingMedia.length} absent or empty`);
  const audioActions = speech.filter(action => action.audioUrl);
  const invalidAudio = audioActions.filter(action => {
    const relative = action.audioUrl.split('?')[0].slice(`/api/openmaic/classroom-media/${classroomId}/`.length);
    const file = path.resolve(classroomDir, classroomId, relative);
    if (!file.startsWith(`${path.resolve(classroomDir, classroomId)}${path.sep}`) || !existsSync(file)) return true;
    const seconds = wavDuration(file);
    return seconds === null || !Number.isFinite(action.audioDurationSec)
      || Math.abs(seconds - action.audioDurationSec) > 0.75;
  });
  check('referenced-audio-decodable-duration', invalidAudio.length === 0,
    `${audioActions.length} narrated segments; ${invalidAudio.length} invalid or mismatched`);

  const uploadIds = [...new Set(collectMedia(scenes).flatMap(url => {
    const match = /^\/api\/uploads\/([0-9a-f-]{36})$/.exec(url);
    return match ? [match[1]] : [];
  }))];
  const uploads = await db.fileAsset.findMany({
    where: { id: { in: uploadIds } },
    select: { id: true, storageKey: true, uploadedById: true, mimeType: true, deletedAt: true },
  });
  const invalidUploads = uploadIds.filter(id => {
    const item = uploads.find(row => row.id === id);
    return !item || item.deletedAt || item.uploadedById !== instance.templateVersion.template.ownerId
      || !existsSync(path.join(uploadDir, item.storageKey)) || statSync(path.join(uploadDir, item.storageKey)).size === 0;
  });
  check('embedded-uploads-present-and-owned', invalidUploads.length === 0,
    `${uploadIds.length} references; ${invalidUploads.length} invalid`);
  const invalidImages = [];
  for (const item of uploads) {
    try {
      const metadata = await sharp(path.join(uploadDir, item.storageKey)).metadata();
      if (!metadata.width || !metadata.height) invalidImages.push(item.id);
    } catch { invalidImages.push(item.id); }
  }
  check('embedded-images-decodable', invalidImages.length === 0,
    `${uploads.length} images; ${invalidImages.length} invalid`);

  const invalidQuizzes = quizzes.flatMap((scene, sceneIndex) => {
    const questions = scene.content?.questions || [];
    if (!questions.length) return [`${sceneIndex}:empty`];
    return questions.filter(question => !question.question?.trim()
      || !question.analysis?.trim()
      || (question.answer || []).some(answer => !(question.options || []).some(option => option.value === answer)))
      .map(question => `${sceneIndex}:${question.id}`);
  });
  check('quiz-questions-and-answers-present', invalidQuizzes.length === 0,
    `${quizzes.length} quizzes; ${invalidQuizzes.length} invalid questions`);
  const obviousPlaceholders = /\b(?:TODO|TBD|Lorem ipsum)\b|待补充|待填写|占位符|生成失败|示例文本|请输入标题|AI回答中/i;
  check('obvious-placeholder-text-absent', !obviousPlaceholders.test(JSON.stringify(scenes)));

  const summary = {
    checkedAt: new Date().toISOString(), offeringId, course: offering.name, offeringStatus: offering.status,
    activityId, activity: activity.title, activityOpen: activity.isOpen, activityArchivedAt: activity.archivedAt,
    chapterOpen: activity.chapter.isOpen,
    instanceId: instance?.id, instanceStatus: instance?.status, instanceEndedAt: instance?.endedAt,
    templateVersion: instance?.templateVersion.version, classroomId,
    scenes: scenes.length, slides: slides.length, quizzes: quizzes.length,
    configuredStages: (snapshot.design?.stages || []).map(({ key, label, view }) => ({ key, label, view })),
    publishedResources: (snapshot.design?.resources || []).map(({ title, type, stageKey, previewType }) =>
      ({ title, type, stageKey, previewType })),
    speechActions: speech.length,
    audioReferences: speech.filter(action => action.audioUrl).length,
    estimatedAudioMinutes: Math.round(speech.reduce((sum, action) => sum + (action.audioDurationSec || 0), 0) / 60),
    embeddedUploadIds: uploadIds, checks,
  };
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (checks.some(item => item.status === '失败')) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
