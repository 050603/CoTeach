// Shared dependency checks used by both the new /api/health/ready route and
// the legacy /api/openmaic/health route. Keeping the logic here lets the
// legacy route stay backward-compatible (same response shape) while reusing
// the same dependency checks.

import { prisma, isDatabaseConfigured } from "@/lib/db/client";
import { getRedisClient } from "@/lib/redis/client";
import { webSocketReadiness } from "@/lib/realtime/websocket-lifecycle";
import { documentConversionHealth } from "@/lib/project-practice/document-conversion-pool";
import { randomUUID } from "node:crypto";
import {
  getServerProviders,
  resolveBaseUrl,
} from "@openmaic/lib/server/provider-config";

export const DEPENDENCY_TIMEOUT_MS = 2000;

export interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ReadinessResult {
  ok: boolean;
  dependencies: Record<string, CheckResult>;
}

/** Run `fn` with a hard timeout; returns its result or `{ ok: false }`. */
async function withTimeout(
  label: string,
  fn: () => Promise<CheckResult>,
): Promise<CheckResult> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<CheckResult>((resolve) =>
        { timer = setTimeout(() => resolve({ ok: false, error: `${label} timeout` }), DEPENDENCY_TIMEOUT_MS); timer.unref?.(); },
      ),
    ]);
    return { ...result, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally { if (timer) clearTimeout(timer); }
}

async function checkDb(): Promise<CheckResult> {
  if (!isDatabaseConfigured()) {
    return { ok: process.env.NODE_ENV !== "production", latencyMs: 0, error: "not_configured" };
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * LLM reachability: we deliberately do NOT call /chat/completions
 * (cost + rate limits). We treat LLM as "reachable" if at least one provider
 * is configured. If a baseUrl is available we do a best-effort HEAD request
 * with the 2s timeout to verify network reachability.
 */
async function checkLlm(): Promise<CheckResult> {
  const providerIds = Object.keys(getServerProviders());
  if (providerIds.length === 0) {
    return { ok: false, error: "no_llm_provider_configured" };
  }
  for (const providerId of providerIds) {
    const baseUrl = resolveBaseUrl(providerId);
    if (!baseUrl) continue;
    try {
      const res = await fetch(baseUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS),
        headers: { "User-Agent": "openpbl-healthcheck/1.0" },
      });
      if (res.status < 500) return { ok: true };
    } catch {
      // try next provider
    }
  }
  return { ok: true };
}

/** Probe the directories that actually hold durable classroom data. */
async function checkFs(): Promise<CheckResult> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const directories = [
    process.env.UPLOAD_DIR || path.resolve(".openpbl-data/uploads"),
    process.env.CLASSROOM_DATA_DIR || path.resolve("data/classrooms"),
    process.env.WHITEBOARD_DATA_DIR || path.resolve(".openpbl-data/whiteboards"),
  ];
  for (const directory of directories) {
    const probe = path.join(directory, `.health-${randomUUID()}`);
    let handle;
    try {
      handle = await fs.open(probe, "wx", 0o600);
      await handle.writeFile("ok");
      await handle.sync();
    } catch { return { ok: false, error: "persistent_storage_unwritable" }; }
    finally { await handle?.close().catch(() => undefined); await fs.unlink(probe).catch(() => undefined); }
  }
  return { ok: true };
}

/** A TCP handshake alone cannot prove that authenticated Redis commands work. */
async function checkRedis(): Promise<CheckResult | undefined> {
  if (!process.env.REDIS_URL) return undefined;
  const client = await getRedisClient();
  if (!client) return { ok: false, error: "redis_unavailable" };
  return { ok: await client.ping() === "PONG" };
}

/**
 * Run all readiness checks in parallel. Returns a map of dependency ->
 * result plus an aggregate `ok` flag.
 */
export async function runReadinessChecks(): Promise<ReadinessResult> {
  const [db, llm, fs, redisResult] = await Promise.all([
    withTimeout("db", checkDb),
    withTimeout("llm", checkLlm),
    withTimeout("fs", checkFs),
    withTimeout("redis", async () =>
      (await checkRedis()) ?? {
        ok: true,
        latencyMs: 0,
        error: "not_configured",
      },
    ),
  ]);

  const dependencies: Record<string, CheckResult> = { db, llm, fs };
  if (process.env.NODE_ENV === "production") dependencies.documentConversion = documentConversionHealth();
  // Surface `redis` only when it was actually checked (configured). The
  // legacy openmaic/health route doesn't expect a `redis` field, so callers
  // that want it should use /api/health/ready.
  if (process.env.REDIS_URL) dependencies.redis = redisResult;

  if (process.env.ENABLE_WEBSOCKET === "true") dependencies.websocket = webSocketReadiness();

  const ok = Object.values(dependencies).every((d) => d.ok);
  return { ok, dependencies };
}
