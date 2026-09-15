import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import type { SessionAction } from "@/lib/session/actions";

export type RealtimeEventType =
  | "course-updated"
  | "stage-changed"
  | "student-joined"
  | "student-left"
  | "submission-updated"
  | "feedback-added"
  | "companion-message"
  | "projection-changed"
  | "showcase-presentation"
  | "public-discussion"
  | "presence-update";

export interface RealtimeEvent {
  type: RealtimeEventType;
  courseId: string;
  at: string;
  payload?: {
    actionType?: SessionAction["type"];
    [key: string]: unknown;
  };
}

export type RealtimeEventHandler = (event: RealtimeEvent) => void;

const CHANNEL = "openpbl:realtime:v1";
const instanceId = randomUUID();
const subscribersByCourse = new Map<string, Set<RealtimeEventHandler>>();
interface ManagedRedisClient {
  isOpen: boolean;
  isReady?: boolean;
  quit(): Promise<string>;
  destroy(): void;
}

interface PublishingRedisClient extends ManagedRedisClient {
  isReady: boolean;
  publish(channel: string, message: string): Promise<number>;
}

let publisher: PublishingRedisClient | null = null;
let subscriber: ManagedRedisClient | null = null;
let initialization: Promise<void> | null = null;
let lastInitializationAttemptAt = 0;
const RECONNECT_THROTTLE_MS = 5_000;

type RedisEnvelope = {
  origin: string;
  event: RealtimeEvent;
};

function dispatchLocal(event: RealtimeEvent): void {
  const handlers = subscribersByCourse.get(event.courseId);
  if (!handlers) return;
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch (error) {
      console.error("[event-bus] subscriber failed:", error);
    }
  }
}

export async function initializeEventBus(): Promise<void> {
  if (publisher?.isReady && subscriber?.isReady) return;
  if (initialization) return initialization;
  const url = process.env.REDIS_URL?.trim();
  if (!url) return;

  const attempt = (async () => {
    lastInitializationAttemptAt = Date.now();
    const staleClients = [publisher, subscriber].filter(
      (candidate): candidate is ManagedRedisClient => Boolean(candidate),
    );
    publisher = null;
    subscriber = null;
    for (const stale of staleClients) {
      if (stale.isOpen) stale.destroy();
    }

    // Fail the initial attempt within a bound so server startup is not held
    // hostage by Redis. A later publish retries after the throttle window.
    const pub = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2_000, reconnectStrategy: false },
    });
    const sub = pub.duplicate();
    pub.on("error", (error) => console.error("[event-bus] Redis publisher error:", error));
    sub.on("error", (error) => console.error("[event-bus] Redis subscriber error:", error));
    try {
      await Promise.all([pub.connect(), sub.connect()]);
      await sub.subscribe(CHANNEL, (message) => {
        try {
          const envelope = JSON.parse(message) as RedisEnvelope;
          if (envelope.origin !== instanceId && envelope.event?.courseId) {
            dispatchLocal(envelope.event);
          }
        } catch (error) {
          console.error("[event-bus] invalid Redis message:", error);
        }
      });
    } catch (error) {
      if (sub.isOpen) sub.destroy();
      if (pub.isOpen) pub.destroy();
      throw error;
    }
    publisher = pub;
    subscriber = sub;
    console.info("[event-bus] Redis cross-instance pub/sub connected");
  })().catch((error) => {
    console.error("[event-bus] Redis unavailable; local delivery remains active:", error);
  });
  initialization = attempt;
  try {
    await attempt;
  } finally {
    if (initialization === attempt) initialization = null;
  }

  return undefined;
}

export async function publishCourseEvent(
  courseId: string,
  event: RealtimeEvent,
): Promise<void> {
  if (!courseId) return;
  dispatchLocal(event);
  const publisherAtStart = publisher;
  const subscriberNeedsRepair = Boolean(
    process.env.REDIS_URL?.trim()
    && !subscriber?.isReady,
  );
  if (!publisherAtStart?.isReady) {
    if (
      process.env.REDIS_URL?.trim()
      && Date.now() - lastInitializationAttemptAt >= RECONNECT_THROTTLE_MS
    ) {
      void initializeEventBus();
    }
    return;
  }
  const envelope: RedisEnvelope = { origin: instanceId, event };
  await publisherAtStart.publish(CHANNEL, JSON.stringify(envelope));
  // A healthy publisher does not imply that this instance still receives
  // events from its peers. Repair the pair after sending the current event so
  // a dead subscriber cannot leave locally connected classrooms stale.
  if (
    subscriberNeedsRepair
    && Date.now() - lastInitializationAttemptAt >= RECONNECT_THROTTLE_MS
  ) {
    void initializeEventBus();
  }
}

export function subscribeCourseEvents(
  courseId: string,
  handler: RealtimeEventHandler,
): RealtimeEventHandler {
  if (!courseId) return handler;
  const handlers = subscribersByCourse.get(courseId) ?? new Set();
  handlers.add(handler);
  subscribersByCourse.set(courseId, handlers);
  return handler;
}

export function unsubscribeCourseEvents(
  courseId: string,
  handler: RealtimeEventHandler,
): void {
  const handlers = subscribersByCourse.get(courseId);
  if (!handlers) return;
  handlers.delete(handler);
  if (handlers.size === 0) subscribersByCourse.delete(courseId);
}

export async function closeEventBus(): Promise<void> {
  const clients: ManagedRedisClient[] = [];
  if (subscriber) clients.push(subscriber);
  if (publisher) clients.push(publisher);
  subscriber = null;
  publisher = null;
  initialization = null;
  await Promise.all(
    clients.map(async (client) => {
      if (!client.isOpen) return;
      if (client.isReady) await client.quit();
      else client.destroy();
    }),
  );
}

export function __resetEventBusForTests(): void {
  subscribersByCourse.clear();
  lastInitializationAttemptAt = 0;
}
