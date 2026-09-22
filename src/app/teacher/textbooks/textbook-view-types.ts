export type TextbookRevisionSummary = {
  id: string;
  version?: number;
  status?: string;
  progress?: number | null;
  createdAt?: string;
};

export type TextbookListItem = {
  id: string;
  title: string;
  author?: string | null;
  authors?: string | null;
  status?: string;
  archivedAt?: string | null;
  currentRevision?: TextbookRevisionSummary | null;
  createdAt?: string;
  updatedAt?: string;
};

export type TextbookSection = {
  id: string;
  parentId?: string | null;
  title: string;
  path?: string | string[] | null;
  level?: number;
  position?: number;
  order?: number;
};

export type TextbookSourceBlock = {
  id: string;
  sectionId?: string | null;
  blockKey?: string;
  blockType?: string;
  position?: number;
  content: string;
  metadata?: Record<string, unknown> | null;
};

export type TextbookEvidence = {
  sourceBlockId: string;
  quoteStart?: number;
  quoteEnd?: number;
  quote?: string;
};

export type TextbookConcept = {
  id: string;
  kind?: string;
  origin?: string;
  sectionId?: string | null;
  name?: string;
  title?: string;
  explanation?: string | null;
  summary?: string | null;
  sourceExcerpt?: string | null;
  sourceBlockIds?: string[];
  aliases?: string[];
  evidence?: TextbookEvidence[];
};

export type TextbookRelation = {
  id?: string;
  sourceConceptId?: string;
  sourceId?: string;
  targetConceptId?: string;
  targetId?: string;
  relationType?: string;
  type?: string;
  origin?: string;
  inferred?: boolean;
  sourceBlockId?: string | null;
  confidence?: number | null;
};

export type TextbookExample = {
  id: string;
  conceptId?: string | null;
  conceptIds?: string[];
  title?: string | null;
  content?: string;
  description?: string;
  sourceExcerpt?: string | null;
  evidence?: TextbookEvidence[];
};

export type TextbookFigure = {
  id: string;
  sourceBlockId?: string | null;
  position?: number;
  width?: number | null;
  height?: number | null;
  conceptId?: string | null;
  conceptIds?: string[];
  sectionId?: string | null;
  caption?: string | null;
  alt?: string | null;
  url?: string | null;
  fileAssetId?: string | null;
  assetId?: string | null;
};

export type TextbookDetailPayload = {
  textbook: TextbookListItem & { description?: string | null; revisions?: TextbookRevisionSummary[] };
  revision?: TextbookRevisionSummary | null;
  sections?: TextbookSection[];
  sourceBlocks?: TextbookSourceBlock[];
  concepts?: TextbookConcept[];
  relations?: TextbookRelation[];
  examples?: TextbookExample[];
  figures?: TextbookFigure[];
  job?: { id?: string; status?: string; progress?: number | null; step?: string | null; message?: string | null; error?: string | null } | null;
};
