// 课堂生成端点（SSE 流式响应）
// 调用 OpenMAIC 原生 generateClassroom()，通过 SSE 把生成进度推送给客户端
// 参数验证失败仍返回 JSON 错误（保持兼容），验证通过后返回 text/event-stream

import { after, type NextRequest } from 'next/server';
import { generateClassroom } from '@openmaic/lib/server/classroom-generation';
import { generateClassroomAssets } from '@openmaic/lib/server/classroom-asset-generation';
import {
  apiError,
  API_ERROR_CODES,
} from '@openmaic/lib/server/api-response';
import { createLogger } from '@openmaic/lib/logger';
import { linkClassroomToCourse } from '@/lib/openmaic-bridge/course-linker';
import { splitGeneratedClassroom } from '@/lib/openmaic-bridge/server-classroom-split';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  isPblModuleTimingPlanConfirmed,
  type PblModuleTimingPlan,
} from '@/lib/pbl-time-model';
import {
  isAbortError,
  throwIfAborted,
} from '@openmaic/lib/generation/generation-retry';
import {
  generateLimiter,
  getClientIp,
  rateLimitKey,
  rateLimitedResponse,
} from '@/lib/auth/rate-limit';
import { isAuthConfigured, readAuthFromRequest } from '@/lib/auth/session';
import { isShuttingDown } from '@/lib/runtime/lifecycle';

const log = createLogger('GenerateAPI');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Vercel: 5 分钟上限

const HEARTBEAT_INTERVAL_MS = 15_000;
const SCENE_OUTLINE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

function normalizeSceneOutlines(input: unknown): SceneOutline[] | undefined {
  if (!Array.isArray(input)) return undefined;
  return input
    .map((item, index) => {
      const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const type =
        typeof raw.type === 'string' && SCENE_OUTLINE_TYPES.has(raw.type) ? raw.type : 'slide';
      const title =
        typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `Scene ${index + 1}`;
      return {
        ...raw,
        id: typeof raw.id === 'string' && raw.id ? raw.id : `scene-${index + 1}`,
        type: type as SceneOutline['type'],
        title,
        description:
          typeof raw.description === 'string' && raw.description.trim()
            ? raw.description.trim()
            : title,
        keyPoints: Array.isArray(raw.keyPoints)
          ? raw.keyPoints.filter((x): x is string => typeof x === 'string')
          : [],
        estimatedDuration:
          typeof raw.estimatedDuration === 'number' ? raw.estimatedDuration : 300,
        order: index,
      } as SceneOutline;
    });
}

function normalizeAgentMode(input: unknown): 'default' | 'generate' {
  return input === 'generate' ? 'generate' : 'default';
}

export async function POST(request: NextRequest) {
  // Reject new requests immediately during graceful shutdown (Stage 7).
  // Returning 503 here keeps clients from starting a 5-minute SSE stream
  // that would be killed mid-way when the process exits.
  if (isShuttingDown()) {
    return Response.json(
      {
        error: 'SERVER_SHUTTING_DOWN',
        message: '服务器维护中,请稍后重试',
      },
      { status: 503 },
    );
  }

  // Stage 3: rate limit course generation (2/min/teacher).
  if (isAuthConfigured()) {
    const claims = await readAuthFromRequest(request);
    const ip = getClientIp(request);
    const userKey = claims?.role === "teacher" ? claims.sub : ip;
    const rl = generateLimiter.check(rateLimitKey(request, userKey));
    if (!rl.allowed) return rateLimitedResponse(rl.retryAfterMs);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Invalid JSON body');
  }

  const {
    requirement,
    generationMode,
    pblProfile,
    moduleTimingPlan,
    pblTeachingActivities,
    pblActivityCatalog,
    knowledgePoints,
    teachingConstraints,
    courseId,
    courseTitle,
    sceneOutlines: rawSceneOutlines,
    enableWebSearch = false,
    enableImageGeneration = false,
    enableVideoGeneration = false,
    enableTTS = false,
    ttsProviderId,
    ttsModelId,
    ttsVoice,
    ttsSpeed,
    ttsLanguage,
    agentMode = 'default',
  } = body as {
    requirement?: string;
    generationMode?: unknown;
    pblProfile?: import('@openmaic/lib/types/generation').UserRequirements['pblProfile'];
    moduleTimingPlan?: PblModuleTimingPlan;
    pblTeachingActivities?: import('@openmaic/lib/types/generation').UserRequirements['pblTeachingActivities'];
    pblActivityCatalog?: import('@openmaic/lib/types/generation').UserRequirements['pblActivityCatalog'];
    knowledgePoints?: Array<{ id: string; name?: string }>;
    teachingConstraints?: import('@openmaic/lib/pedagogy/teaching-constraints').TeachingConstraints;
    courseId?: string;
    courseTitle?: string;
    sceneOutlines?: unknown;
    enableWebSearch?: boolean;
    enableImageGeneration?: boolean;
    enableVideoGeneration?: boolean;
    enableTTS?: boolean;
    ttsProviderId?: string;
    ttsModelId?: string;
    ttsVoice?: string;
    ttsSpeed?: number;
    ttsLanguage?: string;
    agentMode?: unknown;
  };

  // 参数验证失败：仍返回 JSON 错误（HTTP 400），不进入 SSE 流
  if (!requirement || typeof requirement !== 'string') {
    return apiError(
      API_ERROR_CODES.MISSING_REQUIRED_FIELD,
      400,
      'Missing required field: requirement (string)',
    );
  }

  if (
    pblProfile?.generationTemplate === 'pbl-six-stage'
    && !isPblModuleTimingPlanConfirmed(moduleTimingPlan)
  ) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      400,
      'PBL module timing must be confirmed before classroom generation',
    );
  }

  let baseUrl: string;
  try {
    baseUrl = buildRequestOrigin(request);
  } catch {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      500,
      'MISSING_PUBLIC_BASE_URL: set PUBLIC_BASE_URL or run behind a reverse proxy that sets x-forwarded-* headers',
    );
  }
  const sceneOutlines = normalizeSceneOutlines(rawSceneOutlines);
  const encoder = new TextEncoder();
  const generationController = new AbortController();
  const abortGeneration = () => {
    if (!generationController.signal.aborted) {
      generationController.abort(request.signal.reason);
    }
  };
  const onRequestAbort = () => abortGeneration();
  if (request.signal.aborted) {
    abortGeneration();
  } else {
    request.signal.addEventListener('abort', onRequestAbort, { once: true });
  }
  const signal = generationController.signal;

  type BackgroundAssetTask = () => Promise<void>;
  let resolveBackgroundTask!: (task: BackgroundAssetTask | null) => void;
  let backgroundTaskResolved = false;
  const backgroundTaskReady = new Promise<BackgroundAssetTask | null>((resolve) => {
    resolveBackgroundTask = resolve;
  });
  const setBackgroundTask = (task: BackgroundAssetTask | null) => {
    if (backgroundTaskResolved) return;
    backgroundTaskResolved = true;
    resolveBackgroundTask(task);
  };
  const runBackgroundTaskAfterResponse = async () => {
    const task = await backgroundTaskReady;
    if (!task) return;
    try {
      await task();
    } catch (error) {
      log.error('Background classroom asset generation failed:', error);
    }
  };

  // Register before returning the streaming response. The deferred promise
  // lets the task capture the split classroom IDs only after body generation
  // and course linking finish, while `after()` keeps it alive independently of
  // the client connection.
  try {
    after(runBackgroundTaskAfterResponse);
  } catch (error) {
    // Node deployments outside a Next request context still get a best-effort
    // background task rather than losing media generation altogether.
    log.warn('Next after() unavailable; using detached background task:', error);
    void runBackgroundTaskAfterResponse();
  }

  const generationInput = {
    requirement,
    generationMode: generationMode === 'deep-interaction'
      ? 'deep-interaction' as const
      : 'standard' as const,
    pblProfile,
    pblTeachingActivities,
    pblActivityCatalog,
    knowledgePoints,
    teachingConstraints,
    courseTitle,
    sceneOutlines,
    enableWebSearch,
    enableImageGeneration,
    enableVideoGeneration,
    enableTTS,
    ttsProviderId: typeof ttsProviderId === 'string' ? ttsProviderId : undefined,
    ttsModelId: typeof ttsModelId === 'string' ? ttsModelId : undefined,
    ttsVoice: typeof ttsVoice === 'string' ? ttsVoice : undefined,
    ttsSpeed: typeof ttsSpeed === 'number' ? ttsSpeed : undefined,
    ttsLanguage: typeof ttsLanguage === 'string' ? ttsLanguage : undefined,
    agentMode: normalizeAgentMode(agentMode),
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 心跳：防止代理/浏览器在长时间无数据时关闭连接
      const heartbeatTimer = setInterval(() => {
        if (signal.aborted) {
          clearInterval(heartbeatTimer);
          return;
        }
        try {
          controller.enqueue(encoder.encode(`:heartbeat\n\n`));
        } catch {
          abortGeneration();
          // controller 已关闭，忽略
        }
      }, HEARTBEAT_INTERVAL_MS);

      const send = (obj: unknown) => {
        if (signal.aborted) return false;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          return true;
        } catch {
          abortGeneration();
          // controller 已关闭，忽略
        }
      };

      // Graceful shutdown (Stage 7): when the server starts draining, push a
      // dedicated `shutdown` SSE event so the client can surface "服务器维护中"
      // and abort the generation. The `shutdown` event uses the SSE `event:`
      // field so it is distinguishable from regular `data:` progress events.
      const sendShutdownEvent = () => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: shutdown\ndata: ${JSON.stringify({
                reason: 'server_shutting_down',
                message: '服务器维护中,请稍后重试',
              })}\n\n`,
            ),
          );
        } catch {
          // controller already closed — nothing more we can do.
        }
      };

      // Returns true (and triggers abort + shutdown event) when the process
      // is shutting down. Callers should `return` from `start()` immediately
      // after a truthy result so the finally block can close the stream.
      const checkShutdown = (): boolean => {
        if (!isShuttingDown()) return false;
        sendShutdownEvent();
        abortGeneration();
        return true;
      };

      try {
        throwIfAborted(signal);
        if (checkShutdown()) return;
        log.info(
          `Starting classroom generation [courseId=${courseId ?? 'none'}, reqLen=${requirement.length}]`,
        );

        const result = await generateClassroom(
          generationInput,
          {
            signal,
            onProgress: (progress) => {
              throwIfAborted(signal);
              if (checkShutdown()) return;
              log.info(
                `[Generation progress] ${progress.step}: ${progress.progress}% - ${progress.message}`,
              );
              send({
                type: 'progress',
                step: progress.step,
                progress: progress.progress,
                message: progress.message,
              });
            },
          },
        );

        throwIfAborted(signal);
        if (checkShutdown()) return;
        const splitResult = await splitGeneratedClassroom({
          stage: result.stage,
          scenes: result.scenes,
          courseName: courseTitle,
          pblMode:
            pblProfile?.generationTemplate === 'pbl-six-stage' ||
            Boolean(pblTeachingActivities?.length),
          signal,
        });

        // 关联到 CoTeach 课程。此时学生课堂已经完成服务端分流，绝不再
        // 把含教师资源的原始全量课堂暴露给学生端。
        if (courseId) {
          throwIfAborted(signal);
          if (checkShutdown()) return;
          await linkClassroomToCourse(courseId, splitResult.studentClassroomId, {
            scenesCount: splitResult.studentSceneCount,
            stageName: result.stage.name,
            teacherClassroomId: splitResult.teacherClassroomId,
            teacherResourceScenes: splitResult.teacherResourceScenes,
            sceneOutlines: result.assetContext.outlines,
          }, { signal });
        }

        setBackgroundTask(async () => {
          await generateClassroomAssets({
            ...result.assetContext,
            baseUrl,
            studentClassroomId: splitResult.studentClassroomId,
            studentScenes: splitResult.studentScenes,
            teacherClassroomId: splitResult.teacherClassroomId || undefined,
            teacherScenes: splitResult.teacherScenes,
            // The request signal is intentionally not reused. Once the body
            // is ready, assets are an independent server task and should keep
            // running even if the browser closes the SSE connection.
            signal: new AbortController().signal,
          });
        });

        throwIfAborted(signal);
        if (checkShutdown()) return;
        log.info(
          `Classroom generation completed [id=${result.id}, scenes=${result.scenesCount}]`,
        );

        send({
          type: 'done',
          id: result.id,
          scenesCount: splitResult.studentSceneCount,
          studentSceneCount: splitResult.studentSceneCount,
          teacherSceneCount: splitResult.teacherSceneCount,
          teacherClassroomId: splitResult.teacherClassroomId,
          teacherResourceScenes: splitResult.teacherResourceScenes,
          pblCoverage: splitResult.pblCoverage,
          qualityReport: result.qualityReport,
          stage: { id: result.stage.id, name: result.stage.name },
        });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          return;
        }
        log.error('Classroom generation failed:', error);
        send({
          type: 'error',
          error: 'Failed to generate classroom',
          details: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBackgroundTask(null);
        clearInterval(heartbeatTimer);
        request.signal.removeEventListener('abort', onRequestAbort);
        try {
          controller.close();
        } catch {
          // controller 已关闭，忽略
        }
      }
    },
    cancel() {
      abortGeneration();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 禁用缓冲，确保进度实时推送
      'X-Accel-Buffering': 'no',
    },
  });
}

function buildRequestOrigin(request: NextRequest): string {
  // Stage 3: prefer the explicit PUBLIC_BASE_URL env var, then standard
  // reverse-proxy headers, then the Host header. The legacy
  // `http://localhost:3000` fallback was removed — in production behind a
  // reverse proxy at least one of these must be present, otherwise we throw
  // so the caller surfaces MISSING_PUBLIC_BASE_URL instead of generating
  // callback URLs that point at localhost.
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase && /^https?:\/\//.test(envBase)) {
    return envBase.replace(/\/$/, "");
  }
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  const host = request.headers.get('host');
  if (host) {
    const proto = host.startsWith('localhost') ? 'http' : 'https';
    return `${proto}://${host}`;
  }
  throw new Error('MISSING_PUBLIC_BASE_URL');
}
