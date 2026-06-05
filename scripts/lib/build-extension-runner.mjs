import fs from "node:fs";
import path from "node:path";
import {
  buildExtensionRuntime,
  listPluginNpmRuntimeBuildOutputs,
  resolveAugmentedExtensionPackageJson,
  resolveExtensionRuntimeBuildPlan,
  writeExtensionRuntimePackageJson,
} from "./plugin-npm-runtime-build.mjs";

export function buildExtensionUsage(programName) {
  return [
    `usage: node ${programName} [options]`,
    "",
    "Build this extension to package-local dist/ without building the full OpenClaw gateway.",
    "",
    "Options:",
    "  --write-package  Write openclaw.runtimeExtensions (and runtimeSetupEntry when declared)",
    "  --check          Verify dist outputs exist and runtime package metadata is current",
    "  --help           Show this help",
  ].join("\n");
}

export function parseExtensionBuildArgs(argv, programName) {
  let writePackage = false;
  let check = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { help: true, programName };
    }
    if (arg === "--write-package") {
      writePackage = true;
      continue;
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    throw new Error(`unexpected argument: ${arg}\n\n${buildExtensionUsage(programName)}`);
  }

  return { writePackage, check, help: false, programName };
}

function packageRelativePathExists(packageDir, relativePath) {
  return fs.existsSync(path.join(packageDir, relativePath.replace(/^\.\//u, "")));
}

function assertBuiltOutputs(plan) {
  const missing = listPluginNpmRuntimeBuildOutputs(plan).filter(
    (runtimePath) => !packageRelativePathExists(plan.packageDir, runtimePath),
  );
  if (missing.length > 0) {
    throw new Error(
      `missing built runtime outputs for ${plan.pluginDir}: ${missing.join(", ")}`,
    );
  }
}

function assertPackageMetadataCurrent(params) {
  const resolved = resolveAugmentedExtensionPackageJson(params);
  if (!resolved.packageJson) {
    throw new Error(`extension does not require a TypeScript runtime build: ${params.packageDir}`);
  }
  if (resolved.changed) {
    throw new Error(
      `package.json runtime entries are stale for ${resolved.pluginDir}. Re-run with --write-package.`,
    );
  }
}

export async function runExtensionBuild(params) {
  const { repoRoot, packageDir, argv, programName, logLabel = "build-extension" } = params;
  const parsed = parseExtensionBuildArgs(argv, programName);
  if (parsed.help) {
    console.log(buildExtensionUsage(programName));
    return;
  }

  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`extension package.json not found: ${packageJsonPath}`);
  }

  const plan = resolveExtensionRuntimeBuildPlan({ repoRoot, packageDir });
  if (!plan) {
    throw new Error(
      `${path.relative(repoRoot, packageDir) || packageDir} has no TypeScript plugin entries to build`,
    );
  }

  if (parsed.check) {
    assertBuiltOutputs(plan);
    assertPackageMetadataCurrent({ repoRoot, packageDir });
    console.log(`[${logLabel}] ${plan.pluginDir} runtime build is up to date`);
    return;
  }

  const result = await buildExtensionRuntime({ repoRoot, packageDir, logLevel: "warn" });
  if (!result) {
    throw new Error(`failed to build extension runtime for ${plan.pluginDir}`);
  }

  const outputs = listPluginNpmRuntimeBuildOutputs(result);
  console.log(
    `[${logLabel}] built ${result.pluginDir} (${outputs.length} entries -> ${path.relative(repoRoot, result.outDir) || "dist"})`,
  );
  for (const output of outputs) {
    console.log(`  ${output}`);
  }
  if (result.copiedStaticAssets.length > 0) {
    console.log(`  static assets: ${result.copiedStaticAssets.join(", ")}`);
  }

  if (parsed.writePackage) {
    const written = writeExtensionRuntimePackageJson({ repoRoot, packageDir });
    if (written.changed) {
      console.log(
        `[${logLabel}] updated ${path.relative(repoRoot, written.packageJsonPath) || "package.json"} runtime entries`,
      );
    } else {
      console.log(`[${logLabel}] package.json runtime entries already current`);
    }
  } else {
    console.log(`[${logLabel}] tip: re-run with --write-package to set runtimeExtensions`);
  }
}
