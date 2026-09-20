import type { GeneratedSlideContent } from "@openmaic/lib/types/generation";

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
