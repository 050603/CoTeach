// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const migration = readFileSync("prisma/migrations/20260927100000_document_archive_scope_v1/migration.sql", "utf8");
const source = readFileSync("src/lib/project-practice/document-finalize.ts", "utf8");
describe("archive scope migration contract", () => {
  it("keeps the versioned helper volatile/invoker, fixed schema, and two distinct ordered SPI statements", () => {
    expect(migration).toContain("CREATE FUNCTION public.openpbl_document_archive_scope_v1(");
    expect(migration).toContain("LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE");
    expect(migration).toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(migration).toContain("current_setting('transaction_isolation') <> 'read committed'");
    expect(migration).toMatch(/PERFORM ci\.id FROM public\."ClassroomInstance" ci WHERE ci\.id = p_course FOR UPDATE;\s+RETURN QUERY/);
    expect(migration).not.toMatch(/\bEXECUTE\b|\bMATERIALIZED\b|SET\s+(?:LOCAL\s+)?statement_timeout/i);
  });
  it("returns the same entire scoped read as the safe separate-query fallback", () => {
    const fallback = source.match(/scopes = await tx\.\$queryRaw<ArchiveScope\[\]>`(SELECT e[\s\S]*?FOR UPDATE OF p)`/)![1];
    const mapping: Record<string, string> = { "JSON.stringify(input.originalPayload)": "p_original", "input.receiptKey": "p_receipt", artifactId: "p_artifact", "input.submissionId": "p_submission", "input.participationId": "p_person", "input.courseId": "p_course", "input.studentId": "p_student", "input.offeringId": "p_offering" };
    const expected = fallback.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      expect(mapping[key]).toBeDefined(); return mapping[key];
    }).replace(/\b(FROM|JOIN) ("[A-Za-z]+")/g, "$1 public.$2");
    const actual = migration.match(/RETURN QUERY\s+(SELECT[\s\S]*?FOR UPDATE OF p);/)![1];
    expect(actual.replace(/\s+/g, " ").trim()).toBe(expected.replace(/\s+/g, " ").trim());
  });
});
