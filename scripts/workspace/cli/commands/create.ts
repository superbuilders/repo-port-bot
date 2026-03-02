#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";

import * as p from "@clack/prompts";
/**
 * Create a new package from the template.
 */
import { $ } from "bun";

import type { CreateOptions, PackageJson } from "./types";

const TEMPLATE_DIR = "scripts/workspace/cli/.template";

const EMPTY = 0;
const SINGLE = 1;
const FIRST_INDEX = 0;
const SCOPE_NAME_INDEX = 1;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const JSON_INDENT = 4;
const IS_INTERACTIVE = Boolean(process.stdout.isTTY);
const DEFAULT_PACKAGES_DIR = "packages/";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the workspace location for a new package.
 *
 * @param workspacePatterns - Workspace glob patterns from root package.json.
 * @param explicitPackagesDir - Optional explicit package directory from CLI input.
 * @returns Selected package directory relative to the repo root.
 */
async function resolvePackagesDir(
  workspacePatterns: string[],
  explicitPackagesDir?: string,
): Promise<string> {
  const packageLocations = workspacePatterns
    .filter((pattern) => pattern.endsWith("/*"))
    .map((pattern) => pattern.replace("/*", "/"))
    .filter((dir) => !dir.startsWith("apps/"));

  if (explicitPackagesDir) {
    const normalized = explicitPackagesDir.endsWith("/")
      ? explicitPackagesDir
      : `${explicitPackagesDir}/`;

    if (!packageLocations.includes(normalized)) {
      throw new Error(
        `Unknown workspace package location "${explicitPackagesDir}". Expected one of: ${packageLocations.join(", ")}`,
      );
    }

    return normalized;
  }

  if (packageLocations.length === EMPTY) {
    throw new Error("No package workspace patterns found in package.json");
  }

  if (packageLocations.length === SINGLE) {
    return packageLocations[FIRST_INDEX]!;
  }

  if (packageLocations.includes(DEFAULT_PACKAGES_DIR)) {
    return DEFAULT_PACKAGES_DIR;
  }

  if (!IS_INTERACTIVE) {
    throw new Error(
      `Multiple workspace package locations found and no default "${DEFAULT_PACKAGES_DIR}" location exists. Pass --path in non-interactive mode.`,
    );
  }

  const locationResult = await p.select({
    message: "Where should this package live?",
    options: packageLocations.map((dir) => ({
      value: dir,
      label: dir,
    })),
  });

  if (p.isCancel(locationResult)) {
    p.cancel("Cancelled");
    process.exit(EXIT_SUCCESS);
  }

  return locationResult;
}

/**
 * Prompt for a package name if one was not provided via options.
 *
 * @param defaultName - Pre-supplied package name from CLI options.
 * @returns Validated package name.
 */
async function promptPackageName(defaultName?: string): Promise<string> {
  if (defaultName) {
    return defaultName;
  }

  if (!IS_INTERACTIVE) {
    throw new Error("Package name is required in non-interactive mode");
  }

  const result = await p.text({
    message: "Package name",
    placeholder: "my-package or @scope/my-package",
    validate: (value) => {
      if (!value) {
        return "Package name is required";
      }

      if (!/^(@[\w-]+\/)?[\w-]+$/.test(value)) {
        return "Invalid package name format";
      }
    },
  });

  if (p.isCancel(result)) {
    p.cancel("Cancelled");
    process.exit(EXIT_SUCCESS);
  }

  return result;
}

/**
 * Add the new package to root tsconfig.json project references.
 *
 * @param targetDir - Relative path of the newly created package directory.
 */
async function updateTsconfigReferences(targetDir: string): Promise<void> {
  const rootTsConfigPath = "tsconfig.json";

  if (!existsSync(rootTsConfigPath)) {
    return;
  }

  try {
    const content = await Bun.file(rootTsConfigPath).text();
    const config = JSON.parse(content);

    if (Array.isArray(config.references)) {
      const newRef = { path: targetDir };
      const exists = config.references.some((ref: { path: string }) => ref.path === targetDir);

      if (!exists) {
        config.references.push(newRef);
        await Bun.write(rootTsConfigPath, `${JSON.stringify(config, null, JSON_INDENT)}\n`);
        p.log.success("Updated tsconfig.json references");
      }
    }
  } catch {
    p.log.warn("Could not update tsconfig.json (update manually)");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new package from the workspace template.
 *
 * @param options - Creation options
 */
export async function create(options: CreateOptions = {}): Promise<void> {
  const { silent = false } = options;

  const rootPkg: PackageJson = await Bun.file("package.json").json();
  const workspacePatterns = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces?.packages ?? []);

  const packagesDir: string = await resolvePackagesDir(workspacePatterns, options.packagesDir);
  const packageName = await promptPackageName(options.name);

  const dirName = packageName.startsWith("@")
    ? (packageName.split("/")[SCOPE_NAME_INDEX] ?? packageName)
    : packageName;

  const targetDir = join(packagesDir, dirName);

  if (!existsSync(TEMPLATE_DIR)) {
    p.log.error(`Template directory not found: ${TEMPLATE_DIR}`);
    console.log("");
    process.exit(EXIT_FAILURE);
  }

  if (existsSync(targetDir)) {
    p.log.error(`Package already exists at ${targetDir}`);
    console.log("");
    process.exit(EXIT_FAILURE);
  }

  const s = p.spinner();

  s.start("Creating package");

  if (!existsSync(packagesDir)) {
    await $`mkdir -p ${packagesDir}`.quiet();
  }

  await $`cp -r ${TEMPLATE_DIR} ${targetDir}`.quiet();

  const templateRenames = [["package.json.template", "package.json"]] as const;

  for (const [from, to] of templateRenames) {
    const src = join(targetDir, from);

    if (existsSync(src)) {
      await $`mv ${src} ${join(targetDir, to)}`.quiet();
    }
  }

  const filesToProcess = ["package.json", "README.md", "src/index.ts"];

  for (const file of filesToProcess) {
    const filePath = join(targetDir, file);

    if (existsSync(filePath)) {
      let content = await Bun.file(filePath).text();

      content = content.replaceAll("{{name}}", packageName);
      await Bun.write(filePath, content);
    }
  }

  s.stop("Package created");

  await updateTsconfigReferences(targetDir);

  if (!silent) {
    p.note(`cd ${targetDir}\nbun install\nbun run build`, "Next steps");
    p.outro(`Created ${packageName}`);
  }
}
