import type { Scene } from '@openmaic/lib/types/stage';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { OpenMaicSceneOutlineSnapshot } from '@/lib/session/types';

/** Only stable identities bind a saved teaching responsibility to a runtime page.
 * Canonical prose is retained; the editor projects current titles/order separately. */
export function canonicalClassroomOutlines(
  saved: readonly (OpenMaicSceneOutlineSnapshot | SceneOutline)[] | undefined,
  scenes: readonly Scene[],
): SceneOutline[] {
  const byId = new Map((saved ?? []).map((outline) => [outline.id, outline]));
  const seen = new Set<string>();
  return scenes.flatMap((scene) => {
    const outline = byId.get(scene.outlineId || scene.id);
    if (!outline || seen.has(outline.id)) return [];
    seen.add(outline.id);
    return [{
      ...outline,
      type: outline.type === 'quiz' || outline.type === 'interactive' || outline.type === 'pbl'
        ? outline.type : 'slide',
      description: outline.description ?? outline.title,
      keyPoints: outline.keyPoints ?? [],
      order: outline.order ?? scene.order,
    } as SceneOutline];
  });
}
