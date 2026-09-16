import type { GeneratedSlideContent } from "../../src/lib/openmaic/types/generation";
import type { SlideLayoutFinding } from "../../src/lib/openmaic/generation/slide-layout-audit";
import type { RenderedElement } from "../../src/lib/course-quality-review/render-measurements";

declare module "*.css";

declare global {
  interface Window {
    __openPblAuditSlide?: (input: {
      content: GeneratedSlideContent;
      outlineId: string;
    }) => Promise<{
      issues: SlideLayoutFinding[];
      measurements: RenderedElement[];
    }>;
  }
}
