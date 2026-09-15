import type { SceneOutline } from '../types/generation';

export interface SpatialRect { x: number; y: number; width: number; height: number }
export interface SlideTeachingRegion extends SpatialRect {
  id: string;
  kind: 'text' | 'image' | 'formula' | 'table' | 'richtext';
  content: string;
  /** Regions in the same unit must stay together when splitting pages. */
  unitId: string;
  keyPointIndexes: number[];
  knowledgePointIds: string[];
  readingOrder: number;
  fontSize?: number;
  minWidth?: number;
  minHeight?: number;
  imageAspectRatio?: number;
  mediaElementId?: string;
  tableCells?: string[][];
  /** Intentional annotation/containment, never inferred from overlap alone. */
  parentRegionId?: string;
}
export interface SlideTeachingRelation {
  from: string;
  to: string;
  kind: 'sequence' | 'cause' | 'association' | 'containment' | 'comparison';
  label: string;
}
export interface SlideRegionBudget extends SlideTeachingRegion {
  fontSize: number;
  fontFamily: string;
  padding: number;
  lineHeight: number;
  maxLines: number;
  textCapacity: number;
  measuredHeight: number;
  measuredWidth: number;
  fits: boolean;
  tableCapacity?: { rows: number; columns: number };
}
export interface SlideSpatialBudget {
  schemaVersion: 1;
  canvas: { width: 1000; height: 562.5 };
  safeBody: SpatialRect;
  title: { text: string; bounds: SpatialRect; fontSize: number; lineHeight: number; measuredHeight: number; maxLines: number };
  reserveRatio: 0.1;
  regions: SlideRegionBudget[];
  occupied: SpatialRect[];
  remaining: SpatialRect[];
  conflicts: Array<{ first: string; second: string; intersection: SpatialRect }>;
  connectors: Array<{ from: string; to: string; label: string; points: Array<{ x: number; y: number }> }>;
  measurement: 'browser-renderer-fonts-v1' | 'conservative-text-estimate-v1';
}

export function formatSlideSpatialBudget(outline: SceneOutline): string {
  if (!outline.spatialBudget) return '';
  const measurementNote = outline.spatialBudget.measurement === 'browser-renderer-fonts-v1'
    ? 'Formula/table dimensions use actual browser rendering.'
    : 'Browser measurement was unavailable for this page, so dimensions use a conservative text estimate with the same font size, padding and line-height contract.';
  return [
    '## Measured page space before authoring',
    'The following is a candidate layout, not a fixed template. You decide final coordinates. Preserve all required visible content and indivisible units; resolve listed region conflicts in this first draft. Do not shrink below 18px or put precise labels inside generated images.',
    `For this measured page set EVERY text element defaultFontName to Noto Sans SC and every native table cell fontname to Noto Sans SC; explicitly set lineHeight:1.5 and paragraphSpace:5. The title uses the measured title.fontSize and title.bounds. These measured font requirements override generic font examples or course fallback fonts. Preserve your choice of final coordinates.\nUse Noto Sans SC, 10px text padding, 1.5 line height, 5px paragraph spacing: these are the measured renderer parameters. Titles 32–40px; normal body 22–28px. Capacity already reserves 10% for variation. ${measurementNote} For native tables use 6px cell padding and line height 1; reserve the stated measured height.`,
    'When subdividing a region into separate labels, each resulting DSL text box needs its OWN 20px total padding: minimum height = 20 + (wrappedLines × fontSize × 1.5 + paragraphGaps × 5) / 0.9. A parent region capacity does not authorize smaller overflowing child boxes. Preserve this formula when moving/resizing boxes in your first draft.',
    'The attached region-ID sketch (when provided) shows these same bounds and connector channels, not final artwork.',
    JSON.stringify(outline.spatialBudget),
  ].join('\n');
}
