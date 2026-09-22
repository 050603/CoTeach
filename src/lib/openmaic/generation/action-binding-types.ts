import type { GeneratedSlideContent } from "@openmaic/lib/types/generation";
import type { LaserWaypoint, SpeechAnchor, VisualTargetSelector } from "@openmaic/lib/types/action";

export type ActionSupport = "none" | "helpful" | "essential";

export interface SlideElementBinding {
  semanticId: string;
  elementIds: string[];
}

export interface SlideModuleOutput {
  pageId: string;
  content: GeneratedSlideContent;
  bindings: SlideElementBinding[];
}

export interface NarrationAnchor {
  id: string;
  semanticId: string;
  quote: string;
  occurrence?: number;
  visualCue?: {
    type: "spotlight" | "laser";
    necessity: Exclude<ActionSupport, "none">;
    /** Exact rendered target when narration is authored from the actual slide. */
    target?: {
      elementId: string;
      selector?: VisualTargetSelector;
    };
    /** Ordered rendered targets visited by one continuous laser sweep. */
    waypoints?: LaserWaypoint[];
    /** Spoken phrase after which this cue should be removed. */
    endSpeechAnchor?: SpeechAnchor;
    durationMs?: number;
  };
}

export interface NarrationSegment {
  id: string;
  pageId: string;
  text: string;
  semanticIds: string[];
  anchors?: NarrationAnchor[];
}

export interface NarrationModuleOutput {
  pageId: string;
  segments: NarrationSegment[];
}
