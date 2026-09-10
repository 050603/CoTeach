import { afterEach, expect, it, vi } from "vitest";

function redisPair() {
  const subscriber = {
    isOpen: true,
    isReady: true,
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue("OK"),
    destroy: vi.fn(),
    on: vi.fn(),
  };
  const publisher = {
    isOpen: true,
    isReady: true,
    connect: vi.fn().mockResolvedValue(undefined),
    duplicate: vi.fn(() => subscriber),
    publish: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue("OK"),
    destroy: vi.fn(),
    on: vi.fn(),
  };
  return { publisher, subscriber };
}

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("redis", () => ({ createClient: mocks.createClient }));

import {
  closeEventBus,
  initializeEventBus,
  publishCourseEvent,
} from "./event-bus";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeEventBus();
});

it("repairs a dead Redis subscriber even while publishing still works", async () => {
  vi.stubEnv("REDIS_URL", "redis://test.invalid");
  const first = redisPair();
  const replacement = redisPair();
  mocks.createClient
    .mockReturnValueOnce(first.publisher)
    .mockReturnValueOnce(replacement.publisher);
  await initializeEventBus();
  first.subscriber.isReady = false;
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 6_000);

  await publishCourseEvent("course-1", {
    type: "projection-changed",
    courseId: "course-1",
    at: new Date().toISOString(),
  });
  await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(replacement.subscriber.subscribe).toHaveBeenCalledOnce());

  expect(first.publisher.publish).toHaveBeenCalledOnce();
  expect(first.publisher.destroy).toHaveBeenCalledOnce();
  expect(first.subscriber.destroy).toHaveBeenCalledOnce();
});
