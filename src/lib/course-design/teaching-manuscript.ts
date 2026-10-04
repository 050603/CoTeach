import type { TeachingBlueprint } from '@/lib/session/types';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { NarrationModuleOutput } from '@/lib/openmaic/generation/action-binding-types';

/** Read-only execution view of the blueprint's canonical spoken nodes. */
export type TeachingManuscript = {
  sectionId: string;
  segments: Array<{ id: string; text: string }>;
};

export function teachingManuscripts(blueprint: TeachingBlueprint | undefined): TeachingManuscript[] {
  return blueprint?.sections.filter((section) => section.contentMode === 'spoken').map((section) => ({
    sectionId: section.id,
    segments: (() => {
      const nodes = new Map(section.units.flatMap((unit) => unit.explanationNodes ?? [])
        .map((node) => [node.id, node]));
      const ids = section.pptPlanningVersion === 'joint-native-pages-4615-v1'
        ? [...nodes.keys()] : [...new Set(section.pages.flatMap((page) => page.introducesNodeIds ?? []))];
      return ids
        .flatMap((id) => {
          const node = nodes.get(id);
          return node ? [{ id, text: node.content }] : [];
        });
    })(),
  })) ?? [];
}

/** Resolve saved speech, without a model, punctuation rewrite or display-text fallback. */
export function bindTeachingManuscript(outline: SceneOutline,
  manuscripts: readonly TeachingManuscript[]): NarrationModuleOutput {
  const refs = outline.teachingBrief?.manuscript;
  const manuscript = refs && manuscripts.find((item) => item.sectionId === refs.sectionId);
  if (!refs || !manuscript) throw new Error(`页面 ${outline.id} 缺少已保存的小节讲稿`);
  const byId = new Map(manuscript.segments.map((segment) => [segment.id, segment]));
  return { pageId: outline.id, segments: refs.segmentIds.map((id) => {
    const segment = byId.get(id);
    if (!segment?.text.trim()) throw new Error(`页面 ${outline.id} 引用了不存在的讲稿段落 ${id}`);
    return { id, pageId: outline.id, text: segment.text,
      semanticIds: [`${outline.id}:teaching`] };
  }) };
}
