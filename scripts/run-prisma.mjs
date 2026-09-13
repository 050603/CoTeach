import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

const prismaCli = path.join(
  process.cwd(),
  "node_modules",
  "prisma",
  "build",
  "index.js",
);
const prismaEnv = { ...process.env };
// CoTeach connects directly to PostgreSQL. A no-engine/Data Proxy client
// accepts only prisma:// URLs and makes local postgresql:// deployments fail
// during Next.js instrumentation startup.
delete prismaEnv.PRISMA_GENERATE_NO_ENGINE;
prismaEnv.PRISMA_CLIENT_ENGINE_TYPE = "library";

const requestedArgs = process.argv.slice(2);
const ensureOnly = requestedArgs[0] === "ensure";

if (ensureOnly && isGeneratedClientCurrent()) {
  console.log("Prisma Client is current; reusing the existing local query engine.");
  process.exit(0);
}

const prismaArgs = ensureOnly ? ["generate"] : requestedArgs;
const captureGenerateOutput = prismaArgs[0] === "generate";
const result = spawnSync(process.execPath, [prismaCli, ...prismaArgs], {
  cwd: process.cwd(),
  env: prismaEnv,
  stdio: captureGenerateOutput ? "pipe" : "inherit",
  encoding: captureGenerateOutput ? "utf8" : undefined,
});

if (result.error) throw result.error;
if (captureGenerateOutput) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
if (result.status !== 0) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/EPERM: operation not permitted, rename[\s\S]+query_engine-windows\.dll\.node/i.test(output)) {
    console.error(
      "\nPrisma 查询引擎正被运行中的 CoTeach/Node 进程占用。" +
        "请先关闭现有开发服务器（可执行 pnpm dev:stop，或结束对应的 pnpm dev/next dev 进程），再重新启动。" +
        "如果只是重复执行 pnpm dev，项目在 Client 有效时会自动复用，不会再次覆盖 DLL。",
    );
  }
  process.exitCode = result.status ?? 1;
} else if (prismaArgs[0] === "generate") {
  assertLocalQueryEngine();
}

function generatedClientDir() {
  const require = createRequire(import.meta.url);
  const prismaClientEntry = require.resolve("@prisma/client");
  return path.resolve(path.dirname(prismaClientEntry), "..", "..", ".prisma", "client");
}

function isGeneratedClientCurrent() {
  try {
    const clientDir = generatedClientDir();
    const generatedSchema = path.join(clientDir, "schema.prisma");
    const sourceSchema = path.resolve(process.cwd(), "prisma", "schema.prisma");
    if (!existsSync(generatedSchema) || !existsSync(sourceSchema)) return false;
    const hasLocalEngine = readdirSync(clientDir).some((file) =>
      /^(?:lib)?query_engine.+\.node$/.test(file),
    );
    if (!hasLocalEngine) return false;

    const require = createRequire(import.meta.url);
    const installedVersion = JSON.parse(
      readFileSync(require.resolve("@prisma/client/package.json"), "utf8"),
    ).version;
    const generatedVersion = JSON.parse(
      readFileSync(path.join(clientDir, "package.json"), "utf8"),
    ).version;
    return installedVersion === generatedVersion
      && statSync(generatedSchema).mtimeMs >= statSync(sourceSchema).mtimeMs;
  } catch {
    return false;
  }
}

function assertLocalQueryEngine() {
  const clientDir = generatedClientDir();
  const hasLocalEngine = readdirSync(clientDir).some((file) =>
    /^(?:lib)?query_engine.+\.node$/.test(file),
  );
  if (!hasLocalEngine) {
    throw new Error(
      "Prisma Client was generated without a local query engine. " +
        "CoTeach requires the standard library engine for postgresql:// URLs.",
    );
  }
}
