// Node.js runtime 专用的 instrumentation。
//
// 此文件仅在 Node.js runtime 中加载（通过 instrumentation.ts 的条件
// 动态 import），因此可以自由使用 Node.js 内置模块（node:async_hooks、
// node:crypto）和 Node.js API（process.on、process.exit）。
//
// 用途：
//   - 初始化 prom-client 默认指标采集（堆、事件循环、CPU、GC 等）。
//   - 启动 WebSocket 服务器用于实时课堂同步。
//   - 注册 SIGTERM / SIGINT 优雅关闭信号处理器（Stage 7）：
//     翻转关闭标志 → 运行清理钩子 → 关闭 WebSocket → 断开 Prisma → exit 0。

let registered = false;

export async function register(): Promise<void> {
  if (registered) return;
  const { assertProductionEnvironment } = await import("@/lib/config/env");
  assertProductionEnvironment();
  const { installEnvironmentHttpProxy } = await import(
    "@/lib/network/environment-http-proxy"
  );
  installEnvironmentHttpProxy();
  const { initializeServerProviderConfig } = await import(
    "@/lib/openmaic/server/provider-config"
  );
  await initializeServerProviderConfig();
  registered = true;
  // Side-effect import: triggers collectDefaultMetrics() exactly once.
  await import("@/lib/observability/metrics");

  // Legacy CourseGenerationJob/CourseDesignGenerationJob workers were
  // intentionally removed in V2. GenerationJob is persisted by the V2 API;
  // no process may start a worker against the retired tables.

  if (process.env.ENABLE_WEBSOCKET === "true") {
    const { initializeEventBus } = await import("@/lib/realtime/event-bus");
    const { startWebSocketServer } = await import("@/lib/realtime/websocket-server");
    await initializeEventBus();
    const wsPort = Number(process.env.WEBSOCKET_PORT ?? "3001");
    startWebSocketServer(wsPort);
  }
  if (process.env.ENABLE_TLDRAW_SYNC === "true") {
    const { startTldrawSyncServer } = await import(
      "@/lib/realtime/tldraw-sync-server"
    );
    startTldrawSyncServer(Number(process.env.TLDRAW_SYNC_PORT ?? "3002"));
  }

  // Register graceful-shutdown signal handlers (Stage 7).
  await installShutdownHandlers();
}

async function installShutdownHandlers(): Promise<void> {
  const { beginShutdown, SHUTDOWN_TIMEOUT_MS } = await import(
    "@/lib/runtime/lifecycle"
  );
  const { logger } = await import("@/lib/observability/logger");

  let shuttingDown = false;

  const handleSignal = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Hard ceiling: even if beginShutdown() hangs (e.g. a hook ignores its
    // timeout), force-exit slightly after the budget. `.unref()` so this
    // timer doesn't keep the event loop alive on its own.
    const forceExitTimer = setTimeout(() => {
      logger.error(
        { signal, budgetMs: SHUTDOWN_TIMEOUT_MS },
        "graceful shutdown exceeded budget; forcing exit",
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS + 2_000);
    forceExitTimer.unref?.();

    // 1) Flip isShuttingDown() -> health checks return 503, LB drains.
    // 2) Run registered cleanup hooks (each with its own timeout).
    beginShutdown(`received ${signal}`)
      .then(async () => {
        if (process.env.ENABLE_WEBSOCKET === "true") {
          const { closeWebSocketServer } = await import(
            "@/lib/realtime/websocket-server"
          );
          const { closeEventBus } = await import("@/lib/realtime/event-bus");
          await closeWebSocketServer();
          await closeEventBus();
        }
        if (process.env.ENABLE_TLDRAW_SYNC === "true") {
          const { closeTldrawSyncServer } = await import(
            "@/lib/realtime/tldraw-sync-server"
          );
          await closeTldrawSyncServer();
        }

        // 4) Close the database connection. Prisma is always instantiated
        //    (singleton), but if DATABASE_URL is unset (Demo mode) calling
        //    $disconnect is a safe no-op.
        try {
          const { closeRedisClient } = await import("@/lib/redis/client");
          await closeRedisClient();
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Redis client shutdown failed",
          );
        }

        try {
          const { prisma } = await import("@/lib/db/client");
          await prisma.$disconnect();
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "prisma.$disconnect() failed during shutdown",
          );
        }

        // 5) Exit cleanly.
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "graceful shutdown threw; forcing exit",
        );
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
}
