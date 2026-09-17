import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { PPTElement } from '@openmaic/dsl';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import { estimateSpeechDurationSec } from '@openmaic/lib/audio/tts-timing';
import { calibrateGeneratedVisualCues } from '@openmaic/lib/generation/semantic-visual-cues';
import {
  CLASSROOMS_DIR,
  readClassroom,
  updatePersistedClassroomForEditing,
} from '@openmaic/lib/server/classroom-storage';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function visualCueCount(scene: Scene): number {
  return (scene.actions ?? []).filter(
    (action) => action.type === 'spotlight' || action.type === 'laser',
  ).length;
}

type VisualCue = Extract<Action, { type: 'spotlight' | 'laser' }>;

function cueCellId(cue: VisualCue): string | undefined {
  return cue.selector && 'cellId' in cue.selector ? cue.selector.cellId : undefined;
}

function cueQuote(cue: VisualCue): string | undefined {
  return cue.selector && 'quote' in cue.selector ? cue.selector.quote : undefined;
}

function normalizeNarration(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function narrationText(scene: Scene): string {
  return normalizeNarration(
    (scene.actions ?? [])
      .filter((action): action is Extract<Action, { type: 'speech' }> => action.type === 'speech')
      .map((action) => action.text)
      .join(''),
  );
}

function nonNarrationVisualActions(actions: readonly Action[]): Action[] {
  return actions.filter((action) => (
    action.type !== 'speech' && action.type !== 'spotlight' && action.type !== 'laser'
  ));
}

function actionsWithoutVisualCues(actions: readonly Action[]): Action[] {
  return actions.filter((action) => action.type !== 'spotlight' && action.type !== 'laser');
}

function speechActions(actions: readonly Action[]): Action[] {
  return actions.filter((action) => action.type === 'speech');
}

function restoreNarrationActions(current: Scene, source: Scene): Scene {
  if (narrationText(current) !== narrationText(source)) {
    throw new Error(`Slide ${current.order + 1} narration differs from the restoration source`);
  }
  if (
    JSON.stringify(nonNarrationVisualActions(current.actions ?? []))
    !== JSON.stringify(nonNarrationVisualActions(source.actions ?? []))
  ) {
    throw new Error(`Slide ${current.order + 1} non-visual actions changed after the restoration source`);
  }
  if (
    JSON.stringify(speechActions(current.actions ?? []))
    === JSON.stringify(speechActions(source.actions ?? []))
  ) {
    return current;
  }
  const restored = actionsWithoutVisualCues(source.actions ?? []);
  const missingAudio = restored.filter((action) => (
    action.type === 'speech' && action.text.trim() && !action.audioUrl
  ));
  if (missingAudio.length > 0) {
    throw new Error(
      `Slide ${current.order + 1} restoration source is missing ${missingAudio.length} narration audio reference(s)`,
    );
  }
  return { ...current, actions: restored } as Scene;
}

function visualBindings(scene: Scene) {
  const actions = scene.actions ?? [];
  const speechById = new Map(
    actions
      .filter((action): action is Extract<Action, { type: 'speech' }> => action.type === 'speech')
      .map((speech) => [speech.id, speech]),
  );
  return actions
    .filter((action): action is VisualCue => action.type === 'spotlight' || action.type === 'laser')
    .map((cue) => ({
      cue,
      speech: cue.speechId ? speechById.get(cue.speechId) : undefined,
    }));
}

function requireBinding(
  scene: Scene,
  speechText: string,
  expectation: (cue: VisualCue) => boolean,
  description: string,
): void {
  const binding = visualBindings(scene).find(({ speech }) => speech?.text.includes(speechText));
  if (!binding?.speech || !expectation(binding.cue)) {
    throw new Error(
      `Slide ${scene.order + 1} failed acceptance: ${description} (speech contains ${JSON.stringify(speechText)})`,
    );
  }
}

function validateKnownClassroomExamples(classroomId: string, scenes: readonly Scene[]): void {
  if (classroomId !== 'rigLXR_Z4j') return;
  const stageSlide = scenes.find((scene) => scene.type === 'slide' && scene.order === 3);
  const pblSlide = scenes.find((scene) => scene.type === 'slide' && scene.order === 4);
  const designSlide = scenes.find((scene) => scene.type === 'slide' && scene.order === 7);
  if (!stageSlide || !pblSlide || !designSlide) {
    throw new Error('Known acceptance slides 4, 5, and 8 are missing');
  }

  requireBinding(
    stageSlide,
    '小学能承载的呈现方式',
    (cue) => cue.type === 'spotlight'
      && cue.elementId === 'table_9WSX7fJy'
      && cueCellId(cue) === 'r3c2',
    'elementary presentation must spotlight the elementary content-form cell r3c2',
  );
  requireBinding(
    stageSlide,
    '学生有初步抽象思维',
    (cue) => cue.type === 'spotlight'
      && cue.elementId === 'table_9WSX7fJy'
      && cueCellId(cue) === 'r2c3',
    'middle-school cognition must spotlight the middle-school cognition cell r2c3 after the transition',
  );

  requireBinding(
    pblSlide,
    '项目式学习常缩写成PBL',
    (cue) => cue.type === 'laser'
      && (cue.elementId === 'text_DX2GHjDf' || cue.elementId === 'text_zWJBQAhH')
      && cueQuote(cue) === 'PBL',
    'the PBL abbreviation must use a laser on the visible PBL text',
  );
  const pblSpeechId = visualBindings(pblSlide).find(({ cue }) => (
    cue.type === 'laser' && cueQuote(cue) === 'PBL'
  ))?.cue.speechId;
  if (!visualBindings(pblSlide).some(({ cue }) => (
    cue.type === 'spotlight'
    && cue.elementId === 'text_XhBYtbWp'
    && cue.speechId === pblSpeechId
    && (cue.speechOffsetMs ?? 0) > 0
  ))) {
    throw new Error(
      'Slide 5 failed acceptance: traction must be a delayed spotlight in the same natural PBL narration paragraph',
    );
  }
  const transitionHeaderCues = visualBindings(stageSlide).filter(({ cue }) => (
    cue.elementId === 'table_9WSX7fJy'
    && (cueCellId(cue) === 'th2' || cueCellId(cue) === 'th3')
  ));
  if (transitionHeaderCues.length > 0) {
    throw new Error('Slide 4 failed acceptance: stage-transition headers must not receive cues');
  }
  if (visualCueCount(stageSlide) > 6) {
    throw new Error(`Slide 4 failed acceptance: ${visualCueCount(stageSlide)} cues exceeds the limit of 6`);
  }

  const flowTargets = new Set(
    visualBindings(pblSlide)
      .filter(({ cue }) => [
        'text_8xoIvAWx',
        'text_hplmphwO',
        'text_QIGp1YFk',
        'text_M4OLaWOS',
        'text_x0a-UiqG',
      ].includes(cue.elementId))
      .map(({ cue }) => cue.elementId),
  );
  if (flowTargets.size > 1) {
    throw new Error('Slide 5 failed acceptance: the PBL flow must not jump across individual nodes');
  }
  const flowSweep = visualBindings(pblSlide).find(({ cue, speech }) => (
    cue.type === 'laser'
    && speech?.text.includes('它的实施流程有五步')
    && cue.elementId === 'text_8xoIvAWx'
  ));
  const expectedWaypoints = [
    'text_hplmphwO',
    'text_QIGp1YFk',
    'text_M4OLaWOS',
    'text_x0a-UiqG',
  ];
  if (
    flowSweep?.cue.type !== 'laser'
    || JSON.stringify(flowSweep.cue.waypoints?.map((waypoint) => waypoint.elementId))
      !== JSON.stringify(expectedWaypoints)
  ) {
    throw new Error('Slide 5 failed acceptance: the five-step process must use one ordered laser sweep');
  }
  if (visualCueCount(pblSlide) > 6) {
    throw new Error(`Slide 5 failed acceptance: ${visualCueCount(pblSlide)} cues exceeds the limit of 6`);
  }
  const designBindings = visualBindings(designSlide);
  if (
    visualCueCount(designSlide) > 5
    || !designBindings.some(({ cue }) => cue.type === 'spotlight' && cue.elementId === 'shape__l33W-EA')
    || !designBindings.some(({ cue }) => cue.type === 'spotlight' && cue.elementId === 'shape_AsLQiCtC')
  ) {
    throw new Error('Slide 8 failed acceptance: repeated detail jumps were not consolidated into stable regions');
  }
}

function validateVisualBudgets(scenes: readonly Scene[]): void {
  for (const scene of scenes) {
    const cues = (scene.actions ?? []).filter(
      (action): action is VisualCue => action.type === 'spotlight' || action.type === 'laser',
    );
    if (cues.length > 8) {
      throw new Error(`Slide ${scene.order + 1} has ${cues.length} cues; maximum is 8`);
    }
    const lasers = cues.filter((cue) => cue.type === 'laser');
    if (lasers.length > 2) {
      throw new Error(`Slide ${scene.order + 1} has ${lasers.length} lasers; maximum is 2`);
    }
  }
}

function insertRequiredCues(
  scene: Scene,
  cuesBySpeech: ReadonlyMap<string, readonly VisualCue[]>,
  removeCue: (cue: VisualCue) => boolean,
  maximum: number,
): Scene {
  const requiredIds = new Set([...cuesBySpeech.values()].flat().map((cue) => cue.id));
  const actions = (scene.actions ?? []).flatMap((action): Action[] => {
    if ((action.type === 'spotlight' || action.type === 'laser') && removeCue(action)) return [];
    if (action.type === 'speech') {
      const cues = cuesBySpeech.get(action.id);
      if (cues) return [...cues, action];
    }
    return [action];
  });
  const optionalCueIds = actions
    .filter((action): action is VisualCue => (
      (action.type === 'spotlight' || action.type === 'laser') && !requiredIds.has(action.id)
    ))
    .slice(0, Math.max(0, maximum - requiredIds.size))
    .map((cue) => cue.id);
  const retainedCueIds = new Set([...requiredIds, ...optionalCueIds]);
  return {
    ...scene,
    actions: actions.filter((action) => (
      (action.type !== 'spotlight' && action.type !== 'laser') || retainedCueIds.has(action.id)
    )),
  } as Scene;
}

/** Apply deterministic acceptance bindings after local calibration, without changing narration. */
function enforceKnownClassroomBindings(classroomId: string, scenes: readonly Scene[]): Scene[] {
  if (classroomId !== 'rigLXR_Z4j') return [...scenes];
  return scenes.map((scene) => {
    if (scene.type !== 'slide') return scene;
    const speeches = (scene.actions ?? []).filter(
      (action): action is Extract<Action, { type: 'speech' }> => action.type === 'speech',
    );
    if (scene.order === 3) {
      const primary = speeches.find((speech) => speech.text.includes('小学能承载的呈现方式'));
      const middle = speeches.find((speech) => speech.text.includes('学生有初步抽象思维'));
      if (!primary || !middle) throw new Error('Slide 4 required narration was not restored');
      const required = new Map<string, VisualCue[]>([
        [primary.id, [{
          id: `action_${nanoid(8)}`,
          type: 'spotlight',
          elementId: 'table_9WSX7fJy',
          selector: { cellId: 'r3c2' },
          speechId: primary.id,
          endSpeechId: primary.id,
          description: '小学呈现方式必须稳定聚焦对应的内容形态单元格。',
        }]],
        [middle.id, [{
          id: `action_${nanoid(8)}`,
          type: 'spotlight',
          elementId: 'table_9WSX7fJy',
          selector: { cellId: 'r2c3' },
          speechId: middle.id,
          endSpeechId: middle.id,
          description: '中学认知讲解必须稳定聚焦对应的认知特征单元格。',
        }]],
      ]);
      return insertRequiredCues(
        scene,
        required,
        (cue) => (
          cue.speechId === primary.id
          || cue.speechId === middle.id
          || (cue.elementId === 'table_9WSX7fJy'
            && ['r3c2', 'r2c3', 'th2', 'th3'].includes(cueCellId(cue) ?? ''))
        ),
        6,
      );
    }
    if (scene.order === 4) {
      const pbl = speeches.find((speech) => speech.text.includes('项目式学习常缩写成PBL'));
      const flow = speeches.find((speech) => speech.text.includes('它的实施流程有五步'));
      if (!pbl || !flow) {
        throw new Error('Slide 5 required narration was not restored');
      }
      const tractionAnchor = '它的三个核心特征';
      const tractionIndex = pbl.text.indexOf(tractionAnchor);
      if (tractionIndex < 0) throw new Error('Slide 5 traction narration anchor is missing');
      const estimatedDurationMs = estimateSpeechDurationSec(pbl.text, {
        providerId: scene.timingPlan?.providerId,
        modelId: scene.timingPlan?.modelId,
        voiceId: scene.timingPlan?.voiceId,
        language: scene.timingPlan?.language,
        speed: pbl.speed ?? scene.timingPlan?.speed,
        minSeconds: 0,
      }) * 1000;
      const tractionOffsetMs = Math.max(
        2600,
        Math.round((tractionIndex / pbl.text.length) * estimatedDurationMs),
      );
      const required = new Map<string, VisualCue[]>([
        [pbl.id, [{
          id: `action_${nanoid(8)}`,
          type: 'laser',
          elementId: 'text_DX2GHjDf',
          selector: { quote: 'PBL' },
          speechId: pbl.id,
          duration: 2500,
          description: '短暂指出页面中的 PBL 缩写。',
        }, {
          id: `action_${nanoid(8)}`,
          type: 'spotlight',
          elementId: 'text_XhBYtbWp',
          speechId: pbl.id,
          speechOffsetMs: tractionOffsetMs,
          endSpeechId: pbl.id,
          description: '讲解项目式学习的成果目标与真实受众时稳定聚焦牵引力。',
        }]],
        [flow.id, [{
          id: `action_${nanoid(8)}`,
          type: 'laser',
          elementId: 'text_8xoIvAWx',
          waypoints: [
            { elementId: 'text_hplmphwO' },
            { elementId: 'text_QIGp1YFk' },
            { elementId: 'text_M4OLaWOS' },
            { elementId: 'text_x0a-UiqG' },
          ],
          speechId: flow.id,
          duration: 7000,
          description: '以一次连续滑动指引呈现项目式学习的五步流程。',
        }]],
      ]);
      const flowTargets = new Set([
        'text_8xoIvAWx',
        'text_hplmphwO',
        'text_QIGp1YFk',
        'text_M4OLaWOS',
        'text_x0a-UiqG',
      ]);
      return insertRequiredCues(
        scene,
        required,
        (cue) => (
          cue.speechId === pbl.id
          || cue.speechId === flow.id
          || cue.elementId === 'text_XhBYtbWp'
          || flowTargets.has(cue.elementId)
          || cueQuote(cue) === 'PBL'
        ),
        6,
      );
    }
    if (scene.order === 7) {
      const firstSubproblem = speeches.find((speech) => speech.text.includes('第一个子问题问'));
      const finalSubproblem = speeches.find((speech) => speech.text.includes('第三个子问题问'));
      const assessment = speeches.find((speech) => speech.text.includes('评价这边也一样'));
      const rubric = speeches.find((speech) => speech.text.includes('要把这些维度变成能判断的证据'));
      if (!firstSubproblem || !finalSubproblem || !assessment || !rubric) {
        throw new Error('Slide 8 required narration was not restored');
      }
      const required = new Map<string, VisualCue[]>([
        [firstSubproblem.id, [{
          id: `action_${nanoid(8)}`,
          type: 'spotlight',
          elementId: 'shape__l33W-EA',
          speechId: firstSubproblem.id,
          endSpeechId: finalSubproblem.id,
          description: '连续讲解三个子问题时保持左侧拆解区稳定聚焦。',
        }]],
        [assessment.id, [{
          id: `action_${nanoid(8)}`,
          type: 'spotlight',
          elementId: 'shape_AsLQiCtC',
          speechId: assessment.id,
          endSpeechId: rubric.id,
          description: '连续讲解过程证据与量规时保持右侧评价区稳定聚焦。',
        }]],
      ]);
      const replacedTargets = new Set([
        'text_qNqCVTGU',
        'text_QrGasnQY',
        'text_zRHoYnjA',
        'text_R7zY2db7',
        'text_Ppkug779',
        'text_EFwRdrTx',
      ]);
      return insertRequiredCues(
        scene,
        required,
        (cue) => replacedTargets.has(cue.elementId)
          || cue.speechId === firstSubproblem.id
          || cue.speechId === assessment.id,
        5,
      );
    }
    return scene;
  });
}

function outlineFor(scene: Scene, classroomId: string): SceneOutline {
  const acceptanceGuidance = classroomId === 'rigLXR_Z4j' && scene.order === 3
    ? '视觉验收：整页最多 6 个焦点；讲小学呈现方式时 spotlight 表格 r3c2；讲中学认知特征时 spotlight 表格 r2c3；不要给“小学阶段”“中学阶段”等过渡标题添加动作，不要逐句切换单元格。'
    : classroomId === 'rigLXR_Z4j' && scene.order === 4
      ? '视觉验收：整页最多 6 个焦点；介绍 PBL 缩写时用 laser 的 quote="PBL" 指向实际含 PBL 的文本；同一自然讲稿段讲到三个特征时再用 speechOffsetMs 启动 spotlight，稳定聚焦牵引力块 text_XhBYtbWp，不拆分讲稿；五步流程使用一次带 waypoints 的连续 laser 滑动，不生成五个独立动作。'
      : '';
  return {
    id: scene.outlineId || scene.id,
    type: 'slide',
    title: scene.title,
    description: [scene.title, acceptanceGuidance].filter(Boolean).join('\n'),
    keyPoints: [],
    order: scene.order,
    teachingObjective: scene.title,
    audience: scene.audience,
    stageKey: scene.stageKey,
    generationPurpose: scene.generationPurpose,
    knowledgePointIds: scene.knowledgePointIds,
    timingPlan: scene.timingPlan,
  } as SceneOutline;
}

async function main() {
  const classroomId = argument('--classroom');
  const restoreSpeechFrom = argument('--restore-speech-from');
  const apply = process.argv.includes('--apply');
  if (!classroomId || !/^[a-zA-Z0-9_-]+$/.test(classroomId)) {
    throw new Error(
      'Usage: repair-classroom-visual-cues.ts --classroom <id> [--restore-speech-from <backup.json>] [--apply]',
    );
  }
  const current = await readClassroom(classroomId);
  if (!current) throw new Error(`Classroom not found: ${classroomId}`);

  let sourceScenes = current.scenes;
  if (restoreSpeechFrom) {
    const sourcePath = path.resolve(restoreSpeechFrom);
    const source = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as { scenes?: Scene[] };
    if (!Array.isArray(source.scenes) || source.scenes.length !== current.scenes.length) {
      throw new Error('Narration restoration source does not contain the same number of scenes');
    }
    sourceScenes = current.scenes.map((scene, index) => {
      const sourceScene = source.scenes![index];
      if (sourceScene.order !== scene.order || sourceScene.title !== scene.title) {
        throw new Error(`Slide ${index + 1} does not match the narration restoration source`);
      }
      return restoreNarrationActions(scene, sourceScene);
    });
  }

  const plannedScenes = sourceScenes.map((scene): Scene => {
    if (scene.type !== 'slide' || scene.content.type !== 'slide') return scene;
    const actions = calibrateGeneratedVisualCues({
        outline: outlineFor(scene, classroomId),
        elements: scene.content.canvas.elements as PPTElement[],
        actions: scene.actions ?? [],
      });
    return { ...scene, actions } as Scene;
  });
  const repairedScenes = enforceKnownClassroomBindings(classroomId, plannedScenes);

  const summary = repairedScenes
    .filter((scene) => scene.type === 'slide')
    .map((scene) => ({
      page: scene.order + 1,
      title: scene.title,
      speeches: (scene.actions ?? []).filter((action) => action.type === 'speech').length,
      cues: visualCueCount(scene),
      bindings: visualBindings(scene).map(({ cue, speech }) => ({
        type: cue.type,
        elementId: cue.elementId,
        selector: cue.selector,
        speechId: cue.speechId,
        speechOffsetMs: cue.speechOffsetMs,
        endSpeechId: cue.type === 'spotlight' ? cue.endSpeechId : undefined,
        waypoints: cue.type === 'laser' ? cue.waypoints : undefined,
        speech: speech?.text.slice(0, 100),
      })),
    }));
  process.stdout.write(`${JSON.stringify({ classroomId, apply, summary }, null, 2)}\n`);
  validateVisualBudgets(repairedScenes);
  validateKnownClassroomExamples(classroomId, repairedScenes);
  if (!apply) return;

  const sourcePath = path.join(CLASSROOMS_DIR, `${classroomId}.json`);
  const backupPath = path.join(
    CLASSROOMS_DIR,
    `${classroomId}.before-sparse-visual-cues-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await fs.copyFile(sourcePath, backupPath);

  const invalidAudio = repairedScenes.flatMap((scene) => (scene.actions ?? []).filter(
    (action) => action.type === 'speech'
      && action.text.trim()
      && (!action.audioUrl || action.audioInvalidated),
  ));
  if (invalidAudio.length > 0) {
    throw new Error(`Visual-only repair would require ${invalidAudio.length} narration clip(s) to be synthesized`);
  }
  const saved = await updatePersistedClassroomForEditing(
    classroomId,
    { stage: current.stage, scenes: repairedScenes },
    current.revision ?? 0,
  );
  process.stdout.write(`${JSON.stringify({ savedRevision: saved.revision, backupPath }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
