import { normalizeConceptName } from "./text";
import type { ParsedTextbookDocument, TextbookConceptKind } from "./types";

export type ExtractedTextbookConcept = {
  key: string;
  sectionKey: string;
  name: string;
  normalizedName: string;
  aliases: string[];
  kind: TextbookConceptKind;
  explanation: string;
  evidenceBlockKeys: string[];
};

export type ExtractedTextbookRelation = {
  key: string;
  sourceConceptKey: string;
  targetConceptKey: string;
  relationType: "PARENT_OF" | "PRECEDES";
  sourceBlockKey: string | null;
};

export type ExtractedTextbookExample = {
  key: string;
  sectionKey: string;
  sourceBlockKey: string;
  conceptKeys: string[];
  title: string;
  content: string;
};

export type ExtractedTextbookKnowledge = {
  concepts: ExtractedTextbookConcept[];
  relations: ExtractedTextbookRelation[];
  examples: ExtractedTextbookExample[];
  conceptFigureKeys: Array<{ conceptKey: string; figureKey: string }>;
};

function conceptKind(name: string): TextbookConceptKind {
  if (/流程|步骤|过程|阶段/u.test(name)) return "PROCESS";
  if (/原则|要求|建议|策略/u.test(name)) return "PRINCIPLE";
  if (/方法|教学法|模式/u.test(name)) return "METHOD";
  if (/机制|原理/u.test(name)) return "MECHANISM";
  return "CONCEPT";
}

function exampleTitle(content: string, fallback: string): string {
  const explicit = content.match(/(?:例如|比如|举例来说)[，,:：]?\s*([^。！？!?]{4,100})/u)?.[1];
  return (explicit ?? fallback).replace(/[，,；;：:]$/u, "").slice(0, 120);
}

/**
 * Safe deterministic baseline used even when no LLM is configured. It treats
 * authored headings as concepts and never promotes generated text to source
 * evidence.
 */
export function extractTextbookKnowledge(document: ParsedTextbookDocument): ExtractedTextbookKnowledge {
  const blocksBySection = new Map<string, typeof document.blocks>();
  for (const block of document.blocks) {
    if (!block.sectionKey || block.metadata.isDirectory === true) continue;
    const values = blocksBySection.get(block.sectionKey) ?? [];
    values.push(block);
    blocksBySection.set(block.sectionKey, values);
  }
  const conceptSections = document.sections.filter((section) => section.level >= 2);
  const concepts: ExtractedTextbookConcept[] = conceptSections.map((section) => {
    const evidence = (blocksBySection.get(section.key) ?? []).filter((block) => block.type !== "HEADING" && block.type !== "TITLE" && block.content);
    const explanationBlocks = evidence.slice(0, 2);
    return {
      key: `concept-${section.key}`,
      sectionKey: section.key,
      name: section.title,
      normalizedName: normalizeConceptName(section.title),
      aliases: [],
      kind: conceptKind(section.title),
      explanation: explanationBlocks.map((block) => block.content).join("\n"),
      evidenceBlockKeys: explanationBlocks.map((block) => block.key),
    };
  });
  const conceptBySection = new Map(concepts.map((concept) => [concept.sectionKey, concept]));
  const sectionsByKey = new Map(document.sections.map((section) => [section.key, section]));
  const relations: ExtractedTextbookRelation[] = [];
  for (const concept of concepts) {
    let parentKey = sectionsByKey.get(concept.sectionKey)?.parentKey ?? null;
    while (parentKey && !conceptBySection.has(parentKey)) parentKey = sectionsByKey.get(parentKey)?.parentKey ?? null;
    const parent = parentKey ? conceptBySection.get(parentKey) : undefined;
    if (parent) relations.push({
      key: `relation-${parent.key}-${concept.key}`,
      sourceConceptKey: parent.key,
      targetConceptKey: concept.key,
      relationType: "PARENT_OF",
      sourceBlockKey: null,
    });
  }
  const siblings = new Map<string | null, ExtractedTextbookConcept[]>();
  for (const concept of concepts) {
    const parent = sectionsByKey.get(concept.sectionKey)?.parentKey ?? null;
    const values = siblings.get(parent) ?? [];
    values.push(concept);
    siblings.set(parent, values);
  }
  for (const values of siblings.values()) {
    for (let index = 1; index < values.length; index++) relations.push({
      key: `relation-order-${values[index - 1].key}-${values[index].key}`,
      sourceConceptKey: values[index - 1].key,
      targetConceptKey: values[index].key,
      relationType: "PRECEDES",
      sourceBlockKey: null,
    });
  }

  const examples: ExtractedTextbookExample[] = [];
  for (const block of document.blocks) {
    if (!block.sectionKey || block.metadata.isDirectory === true || block.type === "HEADING" || block.type === "TITLE") continue;
    if (!/(?:例如|比如|举例|案例|游戏.{0,20}(?:体验|模拟))/u.test(block.content)) continue;
    const section = sectionsByKey.get(block.sectionKey);
    const direct = conceptBySection.get(block.sectionKey);
    let parentKey = section?.parentKey ?? null;
    while (parentKey && !conceptBySection.has(parentKey)) parentKey = sectionsByKey.get(parentKey)?.parentKey ?? null;
    const parent = parentKey ? conceptBySection.get(parentKey) : undefined;
    examples.push({
      key: `example-${block.key}`,
      sectionKey: block.sectionKey,
      sourceBlockKey: block.key,
      conceptKeys: [direct?.key, parent?.key].filter((value): value is string => Boolean(value)),
      title: exampleTitle(block.content, direct?.name ?? section?.title ?? "教材案例"),
      content: block.content,
    });
  }

  const conceptFigureKeys: Array<{ conceptKey: string; figureKey: string }> = [];
  for (const figure of document.figures) {
    let sectionKey = figure.sectionKey;
    while (sectionKey && !conceptBySection.has(sectionKey)) sectionKey = sectionsByKey.get(sectionKey)?.parentKey ?? null;
    const concept = sectionKey ? conceptBySection.get(sectionKey) : undefined;
    if (concept) conceptFigureKeys.push({ conceptKey: concept.key, figureKey: figure.key });
  }
  return { concepts, relations, examples, conceptFigureKeys };
}
