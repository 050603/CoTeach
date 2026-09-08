import { describe, expect, it } from "vitest";
import { isActivityOpen, isChapterOpen, isOfferingOpen } from "./repository";

const now = new Date("2026-09-08T00:00:00.000Z");

describe("course platform access rules", () => {
  it("requires an open, non-expired invitation and offering", () => {
    expect(isOfferingOpen({ disabledAt: null, expiresAt: null }, "open", now)).toBe(true);
    expect(isOfferingOpen({ disabledAt: new Date("2026-09-07T00:00:00.000Z"), expiresAt: null }, "open", now)).toBe(false);
    expect(isOfferingOpen({ disabledAt: null, expiresAt: new Date("2026-09-07T00:00:00.000Z") }, "open", now)).toBe(false);
    expect(isOfferingOpen({ disabledAt: null, expiresAt: null }, "draft", now)).toBe(false);
  });

  it("applies manual lock before opening time", () => {
    const chapter = { isOpen: true, opensAt: new Date("2026-09-09T00:00:00.000Z"), archivedAt: null };
    const activity = { isOpen: true, opensAt: null, archivedAt: null };
    expect(isChapterOpen(chapter, now)).toBe(false);
    expect(isActivityOpen(chapter, activity, now)).toBe(false);
    expect(isActivityOpen({ ...chapter, opensAt: null }, { ...activity, isOpen: false }, now)).toBe(false);
    expect(isActivityOpen({ ...chapter, opensAt: null }, activity, now)).toBe(true);
  });
});

