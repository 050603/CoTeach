import { fetch } from "undici";
import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import { createSsrfSafeDispatcher } from "@/lib/openmaic/server/ssrf-guard";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RequestSchema = z.object({
  url: z.string().url().max(4_096),
});
const MAX_REDIRECTS = 5;
const MAX_PROXY_BYTES = 25 * 1024 * 1024;
const ALLOWED_CONTENT_TYPE =
  /^(image|video|audio)\/|^application\/(pdf|octet-stream)(?:;|$)/i;

export async function POST(request: Request) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;

  const limit = await checkDistributedRateLimit({
    namespace: "media-proxy",
    key: auth.claims.sub ?? "unknown",
    limit: 60,
    windowSeconds: 60,
  });
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterMs);

  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(request, "INVALID_REQUEST", "A valid media URL is required.", 400);
  }

  let currentUrl = parsed.data.url;
  let upstreamStarted = false;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      upstreamStarted = false;
      const connection = await createSsrfSafeDispatcher(currentUrl);
      upstreamStarted = true;
      let handedToStream = false;
      try {
        const upstream = await fetch(currentUrl, {
          dispatcher: connection.dispatcher,
          redirect: "manual",
          headers: {
            Accept: "image/*,video/*,audio/*,application/pdf,application/octet-stream",
            "User-Agent": "CoTeach-MediaProxy/1.0",
          },
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
        });

        if (upstream.status >= 300 && upstream.status < 400) {
          const location = upstream.headers.get("location");
          await upstream.body?.cancel();
          if (!location) return apiError(request, "UPSTREAM_ERROR", "Invalid upstream redirect.", 502);
          if (hop === MAX_REDIRECTS) {
            return apiError(request, "TOO_MANY_REDIRECTS", "Too many upstream redirects.", 502);
          }
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }

        if (!upstream.ok) {
          await upstream.body?.cancel();
          return apiError(request, "UPSTREAM_ERROR", "The upstream media request failed.", 502);
        }

        const contentType = upstream.headers.get("content-type")?.trim() ?? "";
        if (!ALLOWED_CONTENT_TYPE.test(contentType)) {
          await upstream.body?.cancel();
          return apiError(request, "UNSUPPORTED_MEDIA_TYPE", "Unsupported upstream media type.", 415);
        }
        const contentLength = Number(upstream.headers.get("content-length") ?? "");
        if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BYTES) {
          await upstream.body?.cancel();
          return apiError(request, "MEDIA_TOO_LARGE", "Upstream media exceeds 25 MiB.", 413);
        }
        if (!upstream.body) {
          return apiError(request, "UPSTREAM_ERROR", "Upstream returned an empty body.", 502);
        }

        const body = boundedStream(
          upstream.body as unknown as ReadableStream<Uint8Array>,
          connection.close,
        );
        const response = new Response(body, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
          },
        });
        handedToStream = true;
        return response;
      } finally {
        if (!handedToStream) await connection.close();
      }
    }
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        host: safeHost(currentUrl),
        requestId: request.headers.get("x-request-id"),
      },
      "media proxy request rejected",
    );
  }
  return upstreamStarted
    ? apiError(request, "UPSTREAM_ERROR", "The upstream media request failed.", 502)
    : apiError(request, "INVALID_URL", "The media URL is not allowed.", 403);
}

function boundedStream(
  source: ReadableStream<Uint8Array>,
  close: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let received = 0;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    await close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          await cleanup();
          return;
        }
        received += chunk.value.byteLength;
        if (received > MAX_PROXY_BYTES) {
          await reader.cancel("media too large");
          controller.error(new Error("Upstream media exceeds the configured limit."));
          await cleanup();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await cleanup();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await cleanup();
    },
  });
}

function apiError(request: Request, code: string, message: string, status: number): Response {
  return Response.json(
    {
      code,
      message,
      requestId: request.headers.get("x-request-id") ?? "unknown",
    },
    { status },
  );
}

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid";
  }
}
