/** Semantic authoring inputs compiled to editable PPTElement objects. Geometry
 * and source mappings remain separate from the teaching facts in this scene. */
export type TeachingVisualComponentKind =
  | 'state-change' | 'process' | 'causal' | 'structure' | 'comparison'
  | 'annotated-image' | 'data' | 'worked-example' | 'text';

/** Finite semantic hints for host-owned editable vector glyphs. An icon never
 * supplies a fact, source mapping, measurement or teaching relationship. */
export type TeachingVisualIcon =
  | 'layers' | 'context' | 'book' | 'people' | 'checklist' | 'target' | 'search'
  | 'lightbulb' | 'gear' | 'document' | 'chart' | 'flag' | 'question';

export interface VisualNode {
  id: string;
  label?: string;
  text?: string;
  icon?: TeachingVisualIcon;
  sourceContentIds: string[];
  sourceEvidenceIds?: string[];
  row?: string;
  column?: string;
  parentId?: string;
  /** Normalized coordinates on the referenced image, never slide geometry. */
  anchor?: { x: number; y: number };
  /** Exact node ID in the adopted original diagram. */
  anchorId?: string;
  /** Qualitative support state; it does not imply measured numeric data. */
  supportLevel?: 'present' | 'fading' | 'withdrawn';
  emphasis?: string[];
}

export interface VisualEdge {
  from: string;
  to: string;
  label?: string;
  kind?: 'sequence' | 'cause' | 'association' | 'containment' | 'comparison';
}

export interface TeachingVisualComponent {
  id: string;
  kind: TeachingVisualComponentKind;
  title?: string;
  /** Visual hierarchy only; omitted roles preserve legacy composition. */
  role?: 'primary' | 'support' | 'takeaway';
  /** Supplementary explanation belongs beside this same-page primary node.
   * May reference a node of the host-owned adopted diagram on that page.
   * It does not declare an edge, an arrow or source-content coverage. */
  anchorNodeId?: string;
  nodes: VisualNode[];
  edges?: VisualEdge[];
  resourceId?: string;
  /** The compiler owns the original graph's complete nodes, edges and order. */
  useAdoptedDiagram?: boolean;
  data?: {
    chartType: 'bar' | 'line' | 'pie';
    labels: string[];
    series: Array<{ name: string; values: number[] }>;
    unit?: string;
  };
}

export interface TeachingVisualPage {
  id: string;
  title: string;
  focus: string;
  components: TeachingVisualComponent[];
}

export interface TeachingVisualScene {
  schemaVersion: 1;
  designVersion: 'teaching-visual-v2';
  pages: TeachingVisualPage[];
}

export interface TeachingVisualMetadata {
  scene: TeachingVisualScene;
  pageId: string;
  candidateId: string;
  components: Array<{
    id: string;
    kind: TeachingVisualComponentKind;
    elementIds: string[];
    sourceContentIds: string[];
    locked?: boolean;
    modified?: boolean;
  }>;
  compilerVersion: string;
  themeVersion: string;
  sourceCatalog?: Array<{ id: string; text: string }>;
  adoptedDiagram?: {
    topology: 'sequence' | 'cycle' | 'branch';
    nodes: Array<{ id: string; label: string }>;
    edges?: Array<{ from: string; to: string; label?: string }>;
    sequenceGroups?: Array<{ id: string; label?: string; nodeIds: string[] }>;
    annotation?: string;
  };
  /** Includes absent IDs as tombstones for manually deleted elements. */
  manualElementIds?: string[];
  modifiedSlide?: boolean;
}
