import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(moduleDir, "../..");
const outdir = path.join(moduleDir, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(moduleDir, "client.tsx")],
  outfile: path.join(outdir, "app.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  sourcemap: true,
  minify: false,
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": '"production"' },
});

const rendererMocks = {
  name: "course-quality-lab-renderer-mocks",
  setup(esbuild) {
    esbuild.onResolve({ filter: /(?:@openmaic\/lib\/store\/settings|\/store\/settings)$/ }, () => ({
      path: "lab-settings",
      namespace: "course-quality-lab",
    }));
    esbuild.onLoad({ filter: /.*/, namespace: "course-quality-lab" }, () => ({
      contents: `const state={imageGenerationEnabled:false,videoGenerationEnabled:false,language:"zh-CN",theme:"light"};
        export const useSettingsStore=Object.assign((selector)=>selector(state),{getState:()=>state,subscribe:()=>()=>{}});`,
    }));
    esbuild.onResolve({ filter: /media-orchestrator$/ }, () => ({
      path: "lab-disabled-media",
      namespace: "course-quality-lab-media",
    }));
    esbuild.onLoad({ filter: /.*/, namespace: "course-quality-lab-media" }, () => ({
      contents: "export async function retryMediaTask(){throw new Error('实验查看页不生成媒体')} export async function generateMediaForOutlines(){throw new Error('实验查看页不生成媒体')}",
    }));
  },
};

await build({
  entryPoints: [path.join(moduleDir, "slide-frame.tsx")],
  outfile: path.join(outdir, "slide-frame.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  sourcemap: true,
  minify: false,
  tsconfig: path.join(root, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
  plugins: [rendererMocks],
});

// Build the renderer utilities directly from their source instead of copying a
// possibly absent or stale Next.js build. Without Tailwind's positioning
// utilities, slide elements silently fall back to normal document flow and the
// frame still looks "loaded" even though its layout is unusable.
const tailwindPluginPath = require.resolve("@tailwindcss/postcss");
const tailwindRequire = createRequire(tailwindPluginPath);
const postcss = tailwindRequire("postcss");
const tailwindPostcss = tailwindRequire("@tailwindcss/postcss");
const rendererSourcePath = path.join(root, "src/app/openmaic/globals.css");
const rendererResult = await postcss([tailwindPostcss()]).process(
  await readFile(rendererSourcePath, "utf8"),
  { from: rendererSourcePath },
);
let rendererCss = rendererResult.css;

// esbuild extracts CSS imported by renderer components (currently KaTeX) to
// this sibling file. Keep it in the one stylesheet loaded by the iframe.
const componentCssPath = path.join(outdir, "slide-frame.css");
rendererCss += `\n${await readFile(componentCssPath, "utf8")}\n`;
rendererCss += `
html,body,#slide-frame,.lab-slide-host{width:100%;height:100%;margin:0;overflow:hidden;background:#111827}
html{scrollbar-gutter:auto}
.lab-slide-host{position:relative;display:grid;place-items:center}
.lab-slide-scale{position:absolute;left:50%;top:50%;width:1000px;height:562.5px;transform-origin:center center;translate:-50% -50%}
.lab-slide-fallback{width:100%;height:100%;display:block;object-fit:contain}
.lab-slide-error{color:#cbd5e1;font:16px/1.5 system-ui,sans-serif}
.lab-slide-warning{position:absolute;right:10px;bottom:10px;padding:5px 8px;border-radius:6px;background:#7c2d12;color:#fff;font:12px/1.4 system-ui,sans-serif}
.lab-action-spotlight{position:absolute;z-index:20;border:3px solid rgba(250,204,21,.95);border-radius:10px;box-shadow:0 0 0 1800px rgba(15,23,42,.68),0 0 22px rgba(250,204,21,.8);pointer-events:none}
.lab-action-laser{position:absolute;z-index:21;width:18px;height:18px;margin:-9px 0 0 -9px;border:3px solid white;border-radius:999px;background:#ef4444;box-shadow:0 0 20px 8px rgba(239,68,68,.6);pointer-events:none}
.lab-whiteboard{position:absolute;z-index:30;inset:0;background:white;display:grid;place-items:center;overflow:hidden}
.lab-whiteboard svg{display:block;width:100%;height:100%;max-height:100%;background:white}
`;

const requiredRendererRules = [
  ".absolute {",
  ".relative {",
  ".w-full {",
  ".h-full {",
  ".overflow-hidden {",
];
const missingRendererRules = requiredRendererRules.filter((rule) => !rendererCss.includes(rule));
if (missingRendererRules.length > 0) {
  throw new Error(`Renderer CSS is incomplete; missing ${missingRendererRules.join(", ")}`);
}
await writeFile(path.join(outdir, "renderer.css"), rendererCss, "utf8");

await writeFile(path.join(outdir, "index.html"), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>课程质量实验室</title>
  <link rel="stylesheet" href="/app.css" />
</head>
<body>
  <div id="course-quality-lab-root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`, "utf8");

console.log(`[course-quality-lab] built ${outdir}`);
