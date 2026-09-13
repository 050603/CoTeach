// Prometheus metrics (prom-client) for the CoTeach app.
//
// The default Registry is exported for /api/metrics. Custom metrics must be
// reused across Next.js development-module evaluations because prom-client's
// process registry survives Turbopack hot reloads.

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  type Metric,
  Registry,
  register,
} from "prom-client";

declare global {
  var __openPblDefaultMetricsInitialized: boolean | undefined;
}

if (!globalThis.__openPblDefaultMetricsInitialized) {
  collectDefaultMetrics({
    register: register as Registry,
    eventLoopMonitoringPrecision: 10,
  });
  globalThis.__openPblDefaultMetricsInitialized = true;
}

/**
 * Return the process metric when it already exists, otherwise create it.
 *
 * Without this guard, a Turbopack hot reload can evaluate this module again
 * while prom-client retains its registry. Its constructors then throw
 * "metric ... has already been registered", preventing API routes from loading.
 */
export function getOrCreateRegisteredMetric<T extends Metric>(
  registry: Registry,
  name: string,
  create: () => T,
): T {
  return (registry.getSingleMetric(name) as T | undefined) ?? create();
}

export const httpRequestsTotal = getOrCreateRegisteredMetric(
  register,
  "http_requests_total",
  () =>
    new Counter({
      name: "http_requests_total",
      help: "Total number of HTTP requests handled.",
      labelNames: ["method", "route", "status"] as const,
    }),
);

export const httpRequestDurationSeconds = getOrCreateRegisteredMetric(
  register,
  "http_request_duration_seconds",
  () =>
    new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request latency in seconds.",
      labelNames: ["method", "route"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    }),
);

export const llmCallsTotal = getOrCreateRegisteredMetric(
  register,
  "llm_calls_total",
  () =>
    new Counter({
      name: "llm_calls_total",
      help: "Total number of LLM API calls.",
      labelNames: ["provider", "model", "status"] as const,
    }),
);

export const llmCallDurationSeconds = getOrCreateRegisteredMetric(
  register,
  "llm_call_duration_seconds",
  () =>
    new Histogram({
      name: "llm_call_duration_seconds",
      help: "LLM API call latency in seconds.",
      labelNames: ["provider", "model"] as const,
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
    }),
);

export const llmTokensTotal = getOrCreateRegisteredMetric(
  register,
  "llm_tokens_total",
  () =>
    new Counter({
      name: "llm_tokens_total",
      help: "Total tokens consumed by LLM calls.",
      labelNames: ["provider", "model", "type"] as const,
    }),
);

export const ttsRequestsTotal = getOrCreateRegisteredMetric(
  register,
  "tts_requests_total",
  () =>
    new Counter({
      name: "tts_requests_total",
      help: "Total number of TTS requests.",
      labelNames: ["provider", "status"] as const,
    }),
);

export const websocketConnectionsActive = getOrCreateRegisteredMetric(
  register,
  "websocket_connections_active",
  () =>
    new Gauge({
      name: "websocket_connections_active",
      help: "Number of currently active WebSocket connections.",
    }),
);

export const classroomActiveTotal = getOrCreateRegisteredMetric(
  register,
  "classroom_active_total",
  () =>
    new Gauge({
      name: "classroom_active_total",
      help: "Number of currently active classrooms.",
    }),
);

export const studentsOnlineTotal = getOrCreateRegisteredMetric(
  register,
  "students_online_total",
  () =>
    new Gauge({
      name: "students_online_total",
      help: "Number of students currently online.",
    }),
);

export const dbQueryDurationSeconds = getOrCreateRegisteredMetric(
  register,
  "db_query_duration_seconds",
  () =>
    new Histogram({
      name: "db_query_duration_seconds",
      help: "Database query latency in seconds.",
      labelNames: ["operation"] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    }),
);

export { register };
