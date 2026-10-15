/** A derived concept map, independent of teaching objectives and prerequisites. */
export type CourseMindMapNode = {
  id: string;
  label: string;
  description?: string;
  parentId?: string;
  knowledgePointIds: string[];
  evidenceItemIds?: string[];
  /** Child ordering, including the actual order of a taught procedure. */
  order?: number;
};

export type CourseMindMapRelation = {
  id: string;
  source: string;
  target: string;
  label: string;
  rationale: string;
  evidenceItemIds?: string[];
};

export type CourseMindMapCue = {
  speechId: string;
  nodeId: string;
  anchor: { quote: string; occurrence?: number };
  /** Resolved only from authentic audio alignment; absent when unavailable. */
  startMs?: number;
  /** Bind the resolved timing to the exact narration and audio alignment. */
  speechTextHash?: string;
  audioHash?: string;
};

export type CourseMindMapBinding = {
  sceneId: string;
  /** A concept branch to show before speech, without exposing quiz answers. */
  defaultNodeId: string;
  cues: CourseMindMapCue[];
};

export type CourseMindMap = {
  schemaVersion: 1;
  /** Concept source: adopted evidence, teaching objectives, pages and speech. */
  sourceFingerprint: string;
  /** Audio and speech identities used to resolve the current cue timings. */
  bindingFingerprint: string;
  rootId: string;
  nodes: CourseMindMapNode[];
  relations: CourseMindMapRelation[];
  bindings: CourseMindMapBinding[];
  diagnostics: string[];
};
