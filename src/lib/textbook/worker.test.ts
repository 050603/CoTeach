import { describe, expect, it } from "vitest";
import { textbookConceptEvidenceId } from "./worker";

describe("textbook ingest identities", () => {
  it("namespaces concept evidence by revision", () => {
    const first = textbookConceptEvidenceId("revision-a", "concept-section-12", "block-13");
    const repeated = textbookConceptEvidenceId("revision-a", "concept-section-12", "block-13");
    const secondRevision = textbookConceptEvidenceId("revision-b", "concept-section-12", "block-13");

    expect(first).toBe(repeated);
    expect(first).not.toBe(secondRevision);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
