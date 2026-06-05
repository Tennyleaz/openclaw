#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const programName = path.relative(extensionRoot, fileURLToPath(import.meta.url)).replaceAll("\\", "/");

function findRepoRoot(startDir) {
  let current = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const buildLib = path.join(current, "scripts/lib/plugin-npm-runtime-build.mjs");
    if (fs.existsSync(buildLib)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

async function main() {
  const repoRoot = findRepoRoot(extensionRoot);
  if (!repoRoot) {
    throw new Error(
      [
        "OpenClaw repo root not found from this extension folder.",
        "Run this script from the monorepo checkout.",
        "",
        "From this extension:",
        "  cd extensions/ai-nexus",
        "  npm run build",
        "",
        "From repo root:",
        "  pnpm build:extension ai-nexus --write-package",
      ].join("\n"),
    );
  }

  const { runExtensionBuild } = await import(
    pathToFileURL(path.join(repoRoot, "scripts/lib/build-extension-runner.mjs")).href
  );

  await runExtensionBuild({
    repoRoot,
    packageDir: extensionRoot,
    argv: process.argv.slice(2),
    programName,
    logLabel: "ai-nexus-build",
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
