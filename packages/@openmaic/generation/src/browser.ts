/** Pure authoring and layout primitives. Keep prompt asset loaders and other
 * Node.js services out of this entry so editors can compile native slides. */
export { parseJsonResponse } from './json-repair.js';
export type { JsonParsingOptions } from './json-repair.js';
export { compileTextComponents, TextLayoutError } from './text-layout-compiler.js';
export type { TextMeasure, TextMeasureInput, TextMeasureResult, TextBoxComponent, LabelGridComponent } from './text-layout-compiler.js';
export { AuthoringContentError, resolveAuthoringContent, assertAuthoringContentCoverage, validateAuthoringContent } from './authoring-content.js';
export type { AuthoringContentItem, AuthoringContentReference } from './authoring-content.js';
export {
  compileDiagramComponent, compileMeasuredDiagramComponent, isDiagramComponent,
  measureDiagramAllocations, resolveDiagramSequenceGroups, DiagramAllocationError,
} from './diagram-compiler.js';
export type {
  DiagramComponent, DiagramCompilerOptions, DiagramTypographyOptions, DiagramAllocation,
  DiagramAllocationBounds, MeasuredDiagramCompilerOptions,
} from './diagram-compiler.js';
export type { DiagramPlan, DiagramSequenceGroup } from './outline-types.js';
