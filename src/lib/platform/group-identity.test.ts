import { describe, expect, it, vi } from "vitest";
import { projectGroupStorageId, projectGroupViewId, resolveProjectGroupId } from "./group-identity";
describe("offering-scoped personal group aliases", () => {
  it("gives one student's personal group different storage IDs in different offerings", () => {
    expect(projectGroupStorageId("first", "grp-user")).toBe("first:grp-user");
    expect(projectGroupStorageId("second", "grp-user")).toBe("second:grp-user");
    expect(projectGroupViewId("first", "first:grp-user")).toBe("grp-user");
    expect(projectGroupViewId("second", "first:grp-user")).toBe("first:grp-user");
  });
  it("preserves ordinary group IDs and already namespaced IDs", () => {
    expect(projectGroupStorageId("first", "team-uuid")).toBe("team-uuid");
    expect(projectGroupStorageId("first", "first:grp-user")).toBe("first:grp-user");
    expect(projectGroupViewId("first", "team-uuid")).toBe("team-uuid");
  });
  it("resolves a canonical group before a historical alias, within one offering", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "first:grp-user" });
    const db = { projectGroup: { findFirst } } as never;
    await expect(resolveProjectGroupId(db, "first", "grp-user")).resolves.toBe("first:grp-user");
    expect(findFirst).toHaveBeenCalledOnce();
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "first:grp-user", offeringId: "first" }, select: { id: true } });
  });
  it("supports old unprefixed records without dropping the offering check", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "grp-user" });
    await expect(resolveProjectGroupId({ projectGroup: { findFirst } } as never, "first", "grp-user")).resolves.toBe("grp-user");
    expect(findFirst).toHaveBeenLastCalledWith({ where: { id: "grp-user", offeringId: "first" }, select: { id: true } });
  });
  it("never falls back from an explicitly foreign namespace to the local alias", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(resolveProjectGroupId({ projectGroup: { findFirst } } as never, "second", "first:grp-user")).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledOnce();
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "first:grp-user", offeringId: "second" }, select: { id: true } });
  });
});
