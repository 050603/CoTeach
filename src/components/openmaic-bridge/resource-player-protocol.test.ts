import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { isResourceConfiguration, isResourcePlayback } from "./resource-player-protocol";

describe("embedded resource boundary", () => {
  it("accepts resource snapshots and rejects malformed or student-authoring configurations", () => {
    const state = { version: 1, engineMode: "paused", snapshot: { sceneId: "slide", sceneIndex: 0, actionIndex: 1, consumedDiscussions: [] } };
    expect(isResourcePlayback(state)).toBe(true);
    expect(isResourceConfiguration({ classroomId: "room", sceneId: "slide", experience: "projected-readonly", playbackState: state })).toBe(true);
    expect(isResourceConfiguration({ classroomId: "room", experience: "student-course" })).toBe(false);
    expect(isResourcePlayback({ ...state, snapshot: { ...state.snapshot, actionIndex: Infinity } })).toBe(false);
    expect(isResourcePlayback({ ...state, snapshot: { ...state.snapshot, consumedDiscussions: [null] } })).toBe(false);
    expect(isResourceConfiguration({ classroomId: "room", experience: "teacher-resource", playbackState: {} })).toBe(false);
  });

  it("permits framing only for the same-origin resource document", async () => {
    const headers = await nextConfig.headers!();
    const defaults = headers.find(entry => entry.source === "/(.*)") ?? headers.find(entry => entry.source === "/:path*");
    expect(defaults?.headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    const resource = headers.find(entry => entry.source === "/internal/resource-player");
    expect(resource?.headers).toContainEqual({ key: "X-Frame-Options", value: "SAMEORIGIN" });
    expect(resource?.headers.find(header => header.key === "Content-Security-Policy")?.value).toContain("frame-ancestors 'self'");
    expect(headers.indexOf(resource!)).toBeGreaterThan(headers.indexOf(defaults!));
  });
});
