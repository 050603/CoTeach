import { isEqual } from 'lodash';
import type { TeachingVisualMetadata } from '@openmaic/dsl';
import type { Course, OpenMaicSceneOutlineSnapshot } from '@/lib/session/types';
import type { Scene, Stage } from '@openmaic/lib/types/stage';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { PersistedClassroomData } from './classroom-storage';
import { canonicalClassroomOutlines } from '@/lib/openmaic-bridge/classroom-editor-outlines';
import { resolveSceneOutline } from '@openmaic/lib/agent/client/resolve-scene-outline';
import { slideVisualSourceContent } from '@openmaic/lib/generation/slide-visual-projection';
import { InvalidClassroomEditError } from './classroom-edit';

const ownershipKeys = [
  'stageKey', 'stageLabel', 'audience', 'generationPurpose', 'companionIds', 'companionPrompt',
  'activityId', 'parentActivityId', 'lectureSectionId', 'lectureSectionTitle', 'sectionPlanVersion',
  'detailKind', 'knowledgePointIds', 'teachingUnitIds', 'assessmentUnitIds', 'assessmentUnitMap',
  'assessmentTargets', 'semanticSourceClaims', 'courseVisualDirection',
  'courseVisualTheme', 'narrationMode', 'ttsPolicy',
] as const;
const localPlanKeys = new Set([
  'visibleContent', 'presentationContent', 'presentationItems', 'narrationFocus', 'takeaway',
  'introduces', 'deepens', 'references', 'entryPoint', 'visualRelationship',
]);
const sceneProjectionKeys = [
  'title', 'order', 'targetDurationSec', 'estimatedDuration', 'timingPlan', 'teachingToolPlan',
] as const;

function fail(message: string): never {
  throw new InvalidClassroomEditError(`教学大纲未保存：${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim());
}

function sameDuty(left: SceneOutline, right: SceneOutline): boolean {
  const withoutProjection = (outline: SceneOutline) => Object.fromEntries(Object.entries(outline)
    .filter(([key]) => !(sceneProjectionKeys as readonly string[]).includes(key)));
  return isEqual(withoutProjection(left), withoutProjection(right));
}

function visual(scene: Scene): TeachingVisualMetadata | undefined {
  const value = scene.content.type === 'slide' ? scene.content.canvas.teachingVisual : undefined;
  if (value && (!Array.isArray(value.scene?.pages) || !Array.isArray(value.components)
    || value.scene.pages.some((page) => !record(page) || !Array.isArray(page.components)
      || page.components.some((component) => !record(component) || !Array.isArray(component.nodes)
        || component.nodes.some((node) => !record(node) || !strings(node.sourceContentIds))))
    || value.sourceCatalog !== undefined && (!Array.isArray(value.sourceCatalog)
      || value.sourceCatalog.some((source) => !record(source) || typeof source.id !== 'string' || typeof source.text !== 'string')))) {
    fail('图解来源元数据无效');
  }
  return value;
}

function duration(scene: Scene, outline: SceneOutline): number {
  const value = scene.targetDurationSec ?? outline.targetDurationSec ?? outline.estimatedDuration;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fail('页面缺少有效教学时长');
  return value;
}

function catalog(outline: SceneOutline): Array<{ id: string; text: string }> {
  return outline.visualSourceCatalog !== undefined
    ? outline.visualSourceCatalog : slideVisualSourceContent(outline).map(({ id, text }) => ({ id, text }));
}

function localBrief(original: SceneOutline, submitted: SceneOutline): SceneOutline['teachingBrief'] {
  const originalBrief = original.teachingBrief;
  const proposed = submitted.teachingBrief;
  if (!originalBrief) return undefined;
  if (!proposed) return originalBrief;
  for (const [key, value] of Object.entries(proposed)) {
    if (key !== 'teachingPlan' && key !== 'resourceNeeds'
      && !isEqual(value, originalBrief[key as keyof typeof originalBrief])) {
      fail('原始教学解释、条件和证据不能由客户端改写');
    }
  }
  const originalPlan = originalBrief.teachingPlan;
  const proposedPlan = proposed.teachingPlan;
  if (!originalPlan || !proposedPlan) return originalBrief;
  for (const [key, value] of Object.entries(proposedPlan)) {
    if (!localPlanKeys.has(key) && !isEqual(value, originalPlan[key as keyof typeof originalPlan])) {
      fail('原始教学责任不能由画面短句替代');
    }
  }
  const nodeIds = new Set([
    ...(originalPlan.introduces ?? []), ...(originalPlan.deepens ?? []), ...(originalPlan.references ?? []),
    ...(originalPlan.presentationItems ?? []).flatMap((item) => item.nodeIds),
  ]);
  for (const ids of [proposedPlan.introduces, proposedPlan.deepens, proposedPlan.references,
    proposedPlan.presentationItems?.flatMap((item) => item.nodeIds)]) {
    if (ids?.some((id) => !nodeIds.has(id))) fail('局部教学计划引用了其他页面的知识节点');
  }
  const changes = Object.fromEntries(Object.entries(proposedPlan).filter(([key]) => localPlanKeys.has(key)));
  return { ...originalBrief, teachingPlan: { ...originalPlan, ...changes } };
}

/** Keep canonical facts private and stable. Only a page's local display duties
 * and compiler continuation metadata may be adopted from an editor save. */
export function prepareClassroomEditOutlines(input: {
  course: Course;
  existing: PersistedClassroomData;
  stage: Stage;
  scenes: Scene[];
  outlines: unknown;
}): OpenMaicSceneOutlineSnapshot[] {
  const { existing, scenes } = input;
  if (input.stage.id !== existing.id || scenes.some((scene) => !scene || scene.stageId !== existing.id)) {
    fail('课堂与页面身份不匹配');
  }
  const saved = input.course.content._openmaicSceneOutlines ?? [];
  const canonical = canonicalClassroomOutlines(saved, existing.scenes);
  const beforeById = new Map(existing.scenes.map((scene) => [scene.id, scene]));
  const beforeByOutline = new Map(existing.scenes.map((scene) => [scene.outlineId || scene.id, scene]));
  const canonicalById = new Map(canonical.map((outline) => [outline.id, outline]));
  for (const scene of scenes) {
    const previous = beforeById.get(scene.id);
    if (previous && (previous.outlineId || previous.id) !== (scene.outlineId || scene.id)) {
      fail('现有页面不能绑定另一份教学大纲');
    }
    if (previous) {
      const original = canonicalById.get(previous.outlineId || previous.id);
      for (const key of ownershipKeys) {
        const beforeValue = previous[key as keyof Scene] ?? original?.[key];
        if (scene[key as keyof Scene] !== undefined && !isEqual(scene[key as keyof Scene], beforeValue)) {
          fail('现有页面不能改变原来的章节和知识归属');
        }
      }
    }
  }
  const submittedById = new Map<string, SceneOutline>();
  if (input.outlines !== undefined) {
    if (!Array.isArray(input.outlines)) fail('大纲列表无效');
    for (const outline of input.outlines) {
      if (!record(outline) || typeof outline.id !== 'string' || typeof outline.title !== 'string'
        || !['slide', 'quiz', 'interactive', 'pbl'].includes(String(outline.type))
        || typeof outline.description !== 'string' || !strings(outline.keyPoints)
        || submittedById.has(outline.id)) fail('大纲缺少必要字段或身份重复');
      if (!scenes.some((scene) => (scene.outlineId || scene.id) === outline.id)) {
        fail('大纲不属于当前课堂中的页面');
      }
      if (outline.visualSourceCatalog !== undefined && (!Array.isArray(outline.visualSourceCatalog)
        || outline.visualSourceCatalog.some((source) => !record(source)
          || typeof source.id !== 'string' || typeof source.text !== 'string'))) fail('本页来源目录无效');
      if (outline.teachingBrief !== undefined) {
        if (!record(outline.teachingBrief) || outline.teachingBrief.schemaVersion !== 1) fail('教学说明无效');
        const plan = outline.teachingBrief.teachingPlan;
        if (plan !== undefined && (!record(plan)
          || ['introduces', 'deepens', 'references', 'visibleContent', 'presentationContent', 'narrationFocus']
            .some((key) => plan[key] !== undefined && !strings(plan[key]))
          || plan.presentationItems !== undefined && (!Array.isArray(plan.presentationItems)
            || plan.presentationItems.some((item) => !record(item) || !strings(item.nodeIds)
              || typeof item.text !== 'string')))) fail('局部教学计划无效');
      }
      submittedById.set(outline.id, outline as unknown as SceneOutline);
    }
  }

  const localById = new Map<string, SceneOutline>();
  const checked = new Set<string>();
  for (const scene of scenes) {
    const id = scene.outlineId || scene.id;
    if (!canonicalById.has(id) && visual(scene) && (scene.segmentCount ?? 1) > 1
      && !submittedById.has(id)) fail('续页缺少需要保存的本页教学责任');
  }
  for (const [outlineId, proposed] of submittedById) {
    if (checked.has(outlineId)) continue;
    const previousOutline = canonicalById.get(outlineId);
    const before = beforeByOutline.get(outlineId);
    const after = scenes.find((scene) => (scene.outlineId || scene.id) === outlineId)!;
    if (previousOutline && before && sameDuty(previousOutline, proposed)) {
      checked.add(outlineId);
      continue;
    }
    if (!previousOutline || !before) {
      const group = proposed.segmentGroupId;
      if (!group || !submittedById.has(group) || !canonicalById.has(group)) {
        fail('续页缺少同课堂内可核对的原页');
      }
      // The original page validates its full continuation group below.
      continue;
    }
    const original = resolveSceneOutline(before, [previousOutline]);
    const count = proposed.segmentCount ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 3 || count > 1
      && (proposed.segmentIndex !== 1 || proposed.segmentGroupId !== original.id)) {
      fail('续页必须从指定原页开始且最多三页');
    }
    const group = count > 1 ? scenes.filter((scene) => {
      const outline = submittedById.get(scene.outlineId || scene.id);
      return outline?.segmentGroupId === original.id;
    }) : [after];
    if (group.length !== count || group[0].id !== before.id
      || group.some((scene, index) => scenes.indexOf(scene) !== scenes.indexOf(after) + index)) {
      fail('续页顺序或原页身份不一致');
    }
    const removedSiblings = original.segmentIndex === 1 && original.segmentCount
      ? existing.scenes.filter((scene) => {
        const outline = canonicalById.get(scene.outlineId || scene.id);
        return scene.id !== before.id && outline?.segmentGroupId === original.segmentGroupId
          && !scenes.some((next) => next.id === scene.id);
      }) : [];
    const sourceOutlines = [original, ...removedSiblings.map((scene) =>
      canonicalById.get(scene.outlineId || scene.id)!)];
    const trustedSources = new Map(sourceOutlines.flatMap(catalog).map((source) => [source.id, source.text]));
    const displayedSources = new Set<string>();
    const originalDuration = duration(before, original) + removedSiblings.reduce((total, scene) =>
      total + duration(scene, canonicalById.get(scene.outlineId || scene.id)!), 0);
    let nextDuration = 0;
    const nextPlanned = { narrationSec: 0, learnerActivitySec: 0, transitionSec: 0 };
    for (const [index, scene] of group.entries()) {
      const page = submittedById.get(scene.outlineId || scene.id);
      if (!page || page.type !== original.type || scene.type !== page.type
        || count > 1 && (page.segmentIndex !== index + 1 || page.segmentCount !== count)
        || index > 0 && beforeById.has(scene.id)) {
        fail('续页身份、类型或分段信息无效');
      }
      for (const key of ownershipKeys) {
        if (page[key] !== undefined && !isEqual(page[key], original[key])) {
          fail('局部页面不能改变原来的章节和知识归属');
        }
        if (scene[key as keyof Scene] !== undefined
          && !isEqual(scene[key as keyof Scene], original[key])) fail('页面与大纲的知识归属不一致');
      }
      const sourcePageIds = original.sourcePageIds ?? [original.spatialParentId ?? original.id];
      if (page.sourcePageIds !== undefined && !isEqual(page.sourcePageIds, sourcePageIds)
        || page.spatialParentId !== undefined && page.spatialParentId !== (original.spatialParentId ?? original.id)
        || count > 1 && (!page.sourcePageIds || !page.spatialParentId)) {
        fail('续页不能改变原始教材页面出处');
      }
      const metadata = visual(scene);
      const semanticPage = metadata?.scene.pages.find((item) => item.id === metadata.pageId);
      // Undo may restore the original legacy page, with the same protected
      // source union and original narration. No new visual plan is adopted.
      const restoringLegacy = count === 1 && removedSiblings.length > 0 && !metadata;
      if (!restoringLegacy && (!metadata || metadata.scene.designVersion !== 'teaching-visual-v2' || !semanticPage
        || !metadata.sourceCatalog || metadata.sourceCatalog.some((source) =>
          trustedSources.get(source.id) !== source.text))) fail('图解来源目录无法与原大纲核对');
      const localIds = restoringLegacy ? new Set(trustedSources.keys()) : new Set(semanticPage!.components.flatMap((component) =>
        component.nodes.flatMap((node) => node.sourceContentIds)));
      const localSources = page.visualSourceCatalog ?? [...trustedSources].map(([id, text]) => ({ id, text }));
      if (count > 1 && page.visualSourceCatalog === undefined
        || localSources.some((source) => trustedSources.get(source.id) !== source.text || !localIds.has(source.id))
        || !restoringLegacy && localSources.some((source) => !metadata!.sourceCatalog!.some((entry) => entry.id === source.id && entry.text === source.text))
        || [...localIds].some((id) => !localSources.some((source) => source.id === id))) {
        fail('本页责任与实际图解来源不一致');
      }
      localSources.forEach((source) => displayedSources.add(source.id));
      const originalPlan = original.teachingBrief?.teachingPlan;
      const combinedOriginal: SceneOutline = removedSiblings.length && original.teachingBrief && originalPlan ? {
        ...original, teachingBrief: { ...original.teachingBrief, teachingPlan: { ...originalPlan,
          introduces: [...new Set(sourceOutlines.flatMap((outline) => outline.teachingBrief?.teachingPlan?.introduces ?? []))],
          deepens: [...new Set(sourceOutlines.flatMap((outline) => outline.teachingBrief?.teachingPlan?.deepens ?? []))],
          references: [...new Set(sourceOutlines.flatMap((outline) => outline.teachingBrief?.teachingPlan?.references ?? []))],
          presentationItems: sourceOutlines.flatMap((outline) => outline.teachingBrief?.teachingPlan?.presentationItems ?? []),
        } },
      } : original;
      const brief = localBrief(combinedOriginal, page);
      nextDuration += duration(scene, page);
      if (page.targetDurationSec !== undefined && page.targetDurationSec !== duration(scene, page)) {
        fail('页面与大纲时长不一致');
      }
      if (original.plannedTiming) {
        const planned = page.plannedTiming;
        if (!planned || planned.role !== original.plannedTiming.role
          || Object.keys(nextPlanned).some((key) => {
            const value = planned[key as keyof typeof nextPlanned];
            return typeof value !== 'number' || !Number.isFinite(value) || value < 0;
          }) || Math.abs(planned.narrationSec + planned.learnerActivitySec + planned.transitionSec - duration(scene, page)) > 0.01) {
          fail('续页必须保留原教学与活动时长安排');
        }
        for (const key of Object.keys(nextPlanned) as Array<keyof typeof nextPlanned>) nextPlanned[key] += planned[key];
      }
      // Facts, source identities and ownership are copied from the canonical
      // parent; short display labels remain explicitly local presentation prose.
      localById.set(page.id, {
        ...original, id: page.id, title: scene.title, order: scenes.indexOf(scene),
        description: page.description, keyPoints: page.keyPoints,
        targetDurationSec: duration(scene, page), estimatedDuration: duration(scene, page),
        segmentIndex: page.segmentIndex, segmentCount: page.segmentCount,
        segmentGroupId: page.segmentGroupId, segmentRole: page.segmentRole,
        plannedTiming: page.plannedTiming, timingPlan: scene.timingPlan,
        spatialParentId: page.spatialParentId ?? original.spatialParentId,
        sourcePageIds: page.sourcePageIds ?? original.sourcePageIds,
        spatialSourceContext: original.spatialSourceContext ?? {
          title: original.title, description: original.description,
          teachingObjective: original.teachingObjective,
          coreMessage: original.teachingBrief?.teachingPlan?.newContent ?? original.description,
        },
        visualSourceCatalog: localSources,
        teachingBrief: brief,
        teachingToolPlan: page.teachingToolPlan ?? original.teachingToolPlan,
        visualIntent: original.visualIntent ? { ...original.visualIntent,
          observationGoal: semanticPage?.focus ?? original.visualIntent.observationGoal,
          // A source diagram stays with its actual host; its canonical graph
          // never comes from client-supplied node labels or links.
          diagram: restoringLegacy || semanticPage?.components.some((component) => component.useAdoptedDiagram)
            ? sourceOutlines.find((outline) => outline.visualIntent?.diagram)?.visualIntent?.diagram : undefined,
        } : undefined,
      });
      checked.add(page.id);
    }
    if (Math.abs(nextDuration - originalDuration) > 0.01) fail('拆页必须保留原教学总时长');
    if (original.plannedTiming && (Object.keys(nextPlanned) as Array<keyof typeof nextPlanned>).some((key) =>
      Math.abs(nextPlanned[key] - sourceOutlines.reduce((total, outline) => total + (outline.plannedTiming?.[key] ?? 0), 0)) > 0.01)) {
      fail('拆页改变了原教学与活动时长总量');
    }
    if ([...trustedSources.keys()].some((id) => !displayedSources.has(id))) fail('拆页遗漏了原页教学责任');
  }
  if ([...submittedById.keys()].some((id) => !checked.has(id))) fail('续页未经过原页核对');

  const byId = new Map(saved.map((outline) => [outline.id, outline]));
  const activeIds = new Set<string>();
  const active = scenes.flatMap((scene, order) => {
    const id = scene.outlineId || scene.id;
    if (activeIds.has(id)) return [];
    activeIds.add(id);
    const previous = localById.get(id) ?? byId.get(id);
    const before = beforeById.get(scene.id);
    if (previous && before && !localById.has(id)) {
      // Reordering a neighbor must not synthesize default timing or rewrite its
      // canonical fingerprint. Only explicit edits to that page are projected.
      return [{
        ...previous,
        ...(scene.order !== before.order ? { order } : {}),
        ...(scene.title !== before.title ? { title: scene.title } : {}),
        ...(scene.targetDurationSec !== before.targetDurationSec ? {
          targetDurationSec: scene.targetDurationSec, estimatedDuration: scene.targetDurationSec,
        } : {}),
        ...(!isEqual(scene.teachingToolPlan, before.teachingToolPlan) ? { teachingToolPlan: scene.teachingToolPlan } : {}),
        ...(!isEqual(scene.timingPlan, before.timingPlan) ? { timingPlan: scene.timingPlan } : {}),
      } as OpenMaicSceneOutlineSnapshot];
    }
    return [{
      ...(previous ?? {}), id, type: scene.type, title: scene.title, order,
      description: previous?.description ?? scene.title, keyPoints: previous?.keyPoints ?? [],
      estimatedDuration: scene.targetDurationSec ?? previous?.targetDurationSec ?? previous?.estimatedDuration ?? 60,
      targetDurationSec: scene.targetDurationSec ?? previous?.targetDurationSec ?? previous?.estimatedDuration ?? 60,
      ...(scene.teachingToolPlan ? { teachingToolPlan: scene.teachingToolPlan } : {}),
      ...(scene.timingPlan ? { timingPlan: scene.timingPlan } : {}),
    } as OpenMaicSceneOutlineSnapshot];
  });
  // Inactive teacher resources/source pages are retained verbatim. They cannot
  // be used by the edit agent unless there is a matching current runtime page.
  return [...active, ...saved.filter((outline) => !activeIds.has(outline.id))];
}
