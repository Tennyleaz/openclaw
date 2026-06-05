#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runExtensionBuild } from "./lib/build-extension-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const programName = "scripts/build-extension.mjs";

function usage() {
  return [
    "usage: node scripts/build-extension.mjs <extension-id-or-path> [options]",
    "",
    "Build one OpenClaw extension to package-local dist/ without building the full gateway.",
    "",
    "Examples:",
    "  node scripts/build-extension.mjs ai-nexus",
    "  node scripts/build-extension.mjs ai-nexus --write-package",
    "  cd extensions/ai-nexus && node build.mjs --write-package",
    "  pnpm build:extension ai-nexus --write-package",
    "",
    "Options:",
    "  --write-package  Write openclaw.runtimeExtensions (and runtimeSetupEntry when declared)",
    "  --check          Verify dist outputs exist and runtime package metadata is current",
    "  --help           Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  let extensionArg;
  const runnerArgs = [];

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      runnerArgs.push(arg);
      continue;
    }
    if (extensionArg) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    extensionArg = arg;
  }

  if (!extensionArg) {
    throw new Error(usage());
  }

  return { extensionArg, runnerArgs };
}

function resolveExtensionPackageDir(extensionArg) {
  const normalized = extensionArg.trim().replaceAll("\\", "/");
  if (path.isAbsolute(extensionArg)) {
    return extensionArg;
  }
  if (normalized.startsWith("extensions/")) {
    return path.resolve(repoRoot, normalized);
  }
  if (normalized.includes("/")) {
    return path.resolve(repoRoot, normalized);
  }
  return path.resolve(repoRoot, "extensions", normalized);
}

try {
  const { extensionArg, runnerArgs } = parseArgs(process.argv.slice(2));
  const packageDir = resolveExtensionPackageDir(extensionArg);
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`extension package.json not found: ${packageJsonPath}`);
  }

  await runExtensionBuild({
    repoRoot,
    packageDir,
    argv: runnerArgs,
    programName,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
