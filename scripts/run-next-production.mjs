import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/run-next-production.mjs <build|start|typegen> [...args]");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const distDir = process.env.NEXT_DIST_DIR?.trim() || ".next-build";
let executableArgs = [nextBin, ...args];
const childEnv = { ...process.env, NEXT_DIST_DIR: distDir };

if (args[0] === "start") {
  const standaloneDir = path.resolve(distDir, "standalone");
  const sourceServerFile = path.join(standaloneDir, "server.js");
  try {
    await access(sourceServerFile);
  } catch {
    console.error(`Production build not found in ${distDir}; run pnpm build first.`);
    process.exit(1);
  }

  const buildId = (await readFile(path.resolve(distDir, "BUILD_ID"), "utf8")).trim();
  const releaseDir = path.resolve(".openpbl-runtime", "releases", buildId);
  const releaseServerFile = path.join(releaseDir, "server.js");
  const releaseReadyFile = path.join(releaseDir, ".release-ready");
  try {
    await access(releaseReadyFile);
  } catch {
    await rm(releaseDir, { recursive: true, force: true });
    await mkdir(releaseDir, { recursive: true });
    const runtimeDataDirectories = [".openpbl-data", ".openpbl-runtime"].map((name) =>
      path.join(standaloneDir, name),
    );
    await cp(standaloneDir, releaseDir, {
      recursive: true,
      force: true,
      // Next's standalone trace can include local runtime data. Those files
      // are mutable and already mounted through explicit absolute paths below;
      // copying them into an immutable release races active uploads/audio.
      filter: (source) => !runtimeDataDirectories.some(
        (directory) => source === directory || source.startsWith(`${directory}${path.sep}`),
      ),
    });
    await cp(path.resolve("public"), path.join(releaseDir, "public"), {
      recursive: true,
      force: true,
    });
    await cp(path.resolve(distDir, "static"), path.join(releaseDir, distDir, "static"), {
      recursive: true,
      force: true,
    });
    await writeFile(releaseReadyFile, `${buildId}\n`, "utf8");
  }

  childEnv.PORT ||= "3000";
  childEnv.HOSTNAME ||= "0.0.0.0";
  executableArgs = [releaseServerFile];
}

const child = spawn(process.execPath, executableArgs, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not start Next.js: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
