import type { Action } from '@openmaic/lib/types/action';
import type { SceneContent } from '@openmaic/lib/types/stage';

/** Exact saved inputs prevent a completed redraw from replacing edits made
 * while its model call was in flight. These contain no source catalogue. */
export interface SlideVisualPatch {
  beforeContent: SceneContent;
  beforeActions: Action[];
}
