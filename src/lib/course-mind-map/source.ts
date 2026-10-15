import { createHash } from 'node:crypto';
import type { Course } from '@/lib/session/types';
import type { Scene } from '@/lib/openmaic/types/stage';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function fingerprintMindMapValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Extract visible authoring content without importing layout, animation or media state. */
function visibleContent(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (!['content', 'text', 'label', 'title', 'caption', 'alt', 'latex', 'code', 'formula', 'html', 'labels', 'legends'].includes(key)) return undefined;
    return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (Array.isArray(value)) {
    const content = value.map((item) => visibleContent(item, key)).filter((item) => item !== undefined);
    return content.length ? content : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).flatMap(([name, item]) => {
      // Native chart labels and numerical values are part of the teaching content.
      const projected = visibleContent(item, name);
      return projected === undefined ? [] : [[name, projected]];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return typeof value === 'number' && key === 'data' ? value : undefined;
}

export function courseMindMapSource(course: Course, scenes: Scene[]) {
  const points = course.content.knowledgePoints;
  const evidenceIds = new Set(points.flatMap((point) => point.evidenceItemIds ?? []));
  for (const mapping of course.content.courseEvidence?.mappings ?? []) {
    for (const id of mapping.evidenceItemIds) evidenceIds.add(id);
  }
  return {
    policyVersion: 'course-concept-map-v1',
    course: { id: course.id, name: course.name, learningObjectives: course.learningObjectives },
    knowledgePoints: points,
    evidence: (course.content.courseEvidence?.items ?? [])
      .filter((item) => evidenceIds.has(item.id))
      .map(({ id, title, content, source, completeSourceBlocks, sourceSequences, figureSequences }) =>
        ({ id, title, content, source, completeSourceBlocks, sourceSequences, figureSequences })),
    scenes: scenes.map((scene) => ({
      id: scene.id, type: scene.type, order: scene.order,
      knowledgePointIds: scene.knowledgePointIds ?? [],
      // Assessment content is never used to reveal answers in the navigation map.
      ...(scene.type === 'quiz' ? {} : {
        title: scene.title,
        visibleContent: visibleContent(scene.content),
        speech: (scene.actions ?? []).filter((action) => action.type === 'speech')
          .map((action) => ({ id: action.id, text: action.text })),
      }),
    })),
  };
}

export function computeCourseMindMapSourceFingerprint(course: Course, scenes: Scene[]): string {
  return fingerprintMindMapValue(courseMindMapSource(course, scenes));
}

export function computeCourseMindMapBindingFingerprint(scenes: Scene[]): string {
  return fingerprintMindMapValue(scenes.map((scene) => ({
    id: scene.id, type: scene.type, knowledgePointIds: scene.knowledgePointIds,
    speech: (scene.actions ?? []).filter((action) => action.type === 'speech').map((action) => ({
      id: action.id, text: action.text, audioId: action.audioId, audioUrl: action.audioUrl,
      audioInvalidated: action.audioInvalidated, alignment: action.speechAlignment,
    })),
  })));
}
