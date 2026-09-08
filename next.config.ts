import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack chunk names can remain stable across releases. Stamp asset URLs
  // with the build's deployment id so immutable browser caches cannot keep an
  // older application bundle after a server update.
  deploymentId: process.env.NEXT_DEPLOYMENT_ID?.trim() || undefined,
  // Local production commands set NEXT_DIST_DIR=.next-build so `next build`
  // cannot remove chunks owned by a concurrently running `.next/dev` server.
  // Containers explicitly keep `.next` because their copy paths use it.
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
  // Uploads live on a runtime volume and must never be copied into the
  // standalone image. Node file tracing cannot infer this from a dynamic
  // stored filename, so keep project/runtime data out of these route traces.
  outputFileTracingExcludes: {
    "/api/uploads": [
      "./.openpbl-data/**/*",
      "./coverage/**/*",
      "./deploy/**/*",
      "./docs/**/*",
      "./e2e/**/*",
      "./output/**/*",
      "./packages/**/*",
      "./public/**/*",
      "./src/**/*",
      "./tests/**/*",
      "./*.md",
      "./*.ts",
      "./*.yml",
      "./*.yaml",
    ],
    "/api/uploads/[id]": [
      "./.openpbl-data/**/*",
      "./coverage/**/*",
      "./deploy/**/*",
      "./docs/**/*",
      "./e2e/**/*",
      "./output/**/*",
      "./packages/**/*",
      "./public/**/*",
      "./src/**/*",
      "./tests/**/*",
      "./*.md",
      "./*.ts",
      "./*.yml",
      "./*.yaml",
    ],
  },
  // Interactive Python scenes load these executable assets through a
  // same-origin route. They are read with fs at request time, so explicitly
  // retain them in the standalone image.
  outputFileTracingIncludes: {
    "/api/openmaic/interactive-runtime/**": [
      "./node_modules/codemirror/**/*",
      "./node_modules/katex/dist/**/*",
      "./node_modules/monaco-editor/min/vs/**/*",
      "./node_modules/pyodide/**/*",
    ],
    // sharp 的 prebuilt 二进制在运行时 dlopen vendored libvips 共享库,
    // NFT 追踪不到这些 .so(只带上了 .node 本体),导致 standalone 镜像里
    // 图像处理报 ERR_DLOPEN_FAILED。显式包含整个 @img 目录。
    "/**": [
      "./node_modules/@img/**",
      // PromptLoader reads the Markdown prompt templates with fs at runtime.
      // Keep them in every standalone production build.
      "./src/lib/openmaic/prompts/**/*",
    ],
  },
  // Stage 9: standalone output for minimal Docker images.
  // Produces `.next/standalone` with only the files needed to run the
  // production server (no `node_modules` install required at runtime).
  output: "standalone",
  // Keep React lifecycle checks enabled in development.
  reactStrictMode: true,
  transpilePackages: [
    "@openmaic/dsl",
    "@openmaic/importer",
    "@openmaic/renderer",
    "mathml2omml",
    "pptxgenjs",
  ],
  serverExternalPackages: [
    "sharp",
    "unpdf",
    "undici",
    "jszip",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "pino",
    "pino-pretty",
    "prom-client",
    "redis",
    "ws",
  ],
  images: {
    // Prefer AVIF, fall back to WebP for browsers that don't support AVIF.
    formats: ["image/avif", "image/webp"],
    // Cache optimized images for up to 24 hours on the server.
    minimumCacheTTL: 86400,
  },
  async rewrites() {
    return [
      {
        source: "/logos/:path*",
        destination: "/openmaic/logos/:path*",
      },
      {
        source: "/avatars/:path*",
        destination: "/openmaic/avatars/:path*",
      },
      {
        source: "/logo-horizontal.png",
        destination: "/openmaic/logo-horizontal.png",
      },
      {
        source: "/openmaic-mark.png",
        destination: "/openmaic/openmaic-mark.png",
      },
    ];
  },
  async headers() {
    return [
      {
        // Expose the request id on every response so clients can correlate
        // logs with a request. The static placeholder here guarantees the
        // header is always present; per-request UUIDs are stamped by route
        // handlers via `setRequestContext` / middleware (when present), and
        // any value set on the Response by a handler overrides this default.
        source: "/:path*",
        headers: [
          {
            key: "X-Request-Id",
            value: "unset",
          },
          // ---- Security headers (Stage 3 API hardening) ----
          // HSTS: enforce HTTPS for 1 year, include subdomains, preload-ready.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
          // Prevent MIME-type sniffing.
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          // Disallow framing of the app (clickjacking protection). The
          // OpenMAIC interactive iframe content is served from the same
          // origin via `srcdoc`/blob URLs and is not affected.
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          // Control referrer information sent on outbound navigations.
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          // Permissions policy: disable camera/microphone/geolocation by
          // default. Individual pages can re-enable via the Permissions-Policy
          // header if needed.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
          // Content Security Policy. Allows same-origin scripts/styles,
          // inline styles (Tailwind / styled-components need this), data:
          // images, and https: media. `connect-src` includes ws:/wss: so the
          // realtime WebSocket can connect. `data:` and `blob:` support
          // generated media and interactive classroom workers.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              process.env.NODE_ENV === "development"
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
                : "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "media-src 'self' data: blob: https:",
              "font-src 'self' data:",
              process.env.NODE_ENV === "development"
                ? "connect-src 'self' data: https: ws: wss:"
                : "connect-src 'self' data: wss:",
              "frame-src 'self' blob: data:",
              "worker-src 'self' blob:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
