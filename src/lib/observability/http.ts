import { actionEntryTimings, isActionTimingRequest } from "./action-entry-timing";
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
} from "@/lib/observability/metrics";
import { logger } from "@/lib/observability/logger";

export function withHttpMetrics<Args extends [Request, ...unknown[]]>(
  method: string,
  route: string,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const started = performance.now();
    const actionTiming = isActionTimingRequest(method, new URL(args[0].url).pathname);
    const entryTimings = actionTiming ? actionEntryTimings(args[0].headers, Date.now()) : [];
    let response: Response | undefined;
    let status = 500;
    try {
      response = await handler(...args);
      status = response.status;
      return response;
    } finally {
      const durationSeconds = (performance.now() - started) / 1_000;
      httpRequestsTotal.labels(method, route, String(status)).inc();
      httpRequestDurationSeconds.labels(method, route).observe(durationSeconds);
      logger.info(
        {
          requestId: args[0].headers.get("x-request-id") ?? undefined,
          method,
          route,
          status,
          durationMs: Math.round(durationSeconds * 1_000),
        },
        "request completed",
      );
      if (actionTiming && response) {
        response.headers.append("Server-Timing", [
          ...entryTimings,
          `handler;dur=${(performance.now() - started).toFixed(2)}`,
        ].join(", "));
      }
    }
  };
}
