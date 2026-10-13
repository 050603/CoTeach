import { afterEach, expect, it, vi } from "vitest";
import {
  COLLABORATION_BROWSER_TIMEOUT_MS,
  COLLABORATION_EXECUTION_TIMEOUT_MS,
  COLLABORATION_REQUEST_LEASE_MS,
} from "./request-budget";

afterEach(() => vi.useRealTimers());

it("allows a slow reasoning review to finish before the browser and lease expire", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const generation = new Promise<void>(resolve => setTimeout(() => { events.push("generated"); resolve(); }, 45_000));
  const reviewed = generation.then(() => new Promise<void>(resolve => setTimeout(() => { events.push("reviewed"); resolve(); }, 45_000)));
  const execution = setTimeout(() => events.push("execution-timeout"), COLLABORATION_EXECUTION_TIMEOUT_MS);
  setTimeout(() => events.push("transport-timeout"), COLLABORATION_BROWSER_TIMEOUT_MS);
  setTimeout(() => events.push("lease-expired"), COLLABORATION_REQUEST_LEASE_MS);
  await vi.advanceTimersByTimeAsync(90_000);
  await reviewed;
  expect(events).toEqual(["generated", "reviewed"]);
  clearTimeout(execution);
  expect(COLLABORATION_BROWSER_TIMEOUT_MS - COLLABORATION_EXECUTION_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  expect(COLLABORATION_REQUEST_LEASE_MS - COLLABORATION_BROWSER_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
});
