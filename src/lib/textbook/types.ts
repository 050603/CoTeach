/** Browser-safe contracts shared by the textbook library UI and server routes. */
export type TextbookLifecycleStatus = "ACTIVE" | "ARCHIVED";
export type TextbookRevisionStatus =
  | "PENDING"
  | "PARSING"
  | "WAITING_EMBEDDING"
  | "READY"
  | "FAILED";

export type TextbookBlockType = "TITLE" | "HEADING" | "PARAGRAPH" | "LIST_ITEM" | "TABLE" | "CAPTION";
export type TextbookSectionKind = "FRONT_MATTER" | "CHAPTER" | "SECTION" | "SUBSECTION";
export type TextbookConceptKind = "CONCEPT" | "PRINCIPLE" | "PROCESS" | "METHOD" | "MECHANISM";
export type TextbookEvidenceSupport = "DIRECT" | "PARTIAL" | "RELATED" | "NONE";

export type ParsedTextbookSection = {
  key: string;
  parentKey: string | null;
  title: string;
  path: string;
  kind: TextbookSectionKind;
  level: number;
  position: number;
};

export type ParsedTextbookBlock = {
  key: string;
  sectionKey: string | null;
  type: TextbookBlockType;
  position: number;
  content: string;
  /** Parser facts only. Material text never becomes executable instructions. */
  metadata: Record<string, string | number | boolean | string[] | null>;
};

export type ParsedTextbookFigure = {
  key: string;
  sectionKey: string | null;
  sourceBlockKey: string | null;
  relationshipId: string;
  archivePath: string;
  originalName: string;
  mimeType: string;
  bytes: Uint8Array;
  caption: string;
  position: number;
  width: number | null;
  height: number | null;
};

export type ParsedTextbookDocument = {
  title: string;
  author: string;
  sections: ParsedTextbookSection[];
  blocks: ParsedTextbookBlock[];
  figures: ParsedTextbookFigure[];
  warnings: string[];
};

export type TextbookRetrievalChunk = {
  key: string;
  sectionKey: string | null;
  sourceBlockKeys: string[];
  kind: "SOURCE_BLOCK";
  title: string | null;
  content: string;
  searchTokens: string;
  position: number;
};

export type TextbookEvidenceSearchHit = {
  retrievalItemId: string;
  revisionId: string;
  sectionId: string | null;
  sourceBlockId: string | null;
  conceptId: string | null;
  exampleId: string | null;
  kind: string;
  title: string | null;
  content: string;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
};

export type TextbookEvidenceSearchResult = {
  query: string;
  degraded: boolean;
  degradationReason: string | null;
  hits: TextbookEvidenceSearchHit[];
};

export type TextbookJobSnapshot = {
  id: string;
  status: string;
  step: string | null;
  progress: number;
  error: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
};
