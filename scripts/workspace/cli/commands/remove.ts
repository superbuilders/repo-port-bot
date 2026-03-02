#!/usr/bin/env bun
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import * as p from "@clack/prompts";
/**
 * Remove a package from the monorepo.
 */
import { $ } from "bun";

import type { PackageInfo, PackageJson, RemoveOptions } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY = 0;
const EXIT_SUCCESS = 0;
const JSON_INDENT = 4;
const IS_INTERACTIVE = Boolean(process.stdout.isTTY);

// ─────────────────────────────────────────────────────────────────────────────
// Main Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove a package from the monorepo.
 *
 * @param options - Removal options
 */
export async function remove(options: RemoveOptions = {}): Promise<void> {
  const { silent = false, force = false } = options;

  // Read workspace locations from package.json
  const rootPkg: PackageJson = await Bun.file("package.json").json();
  const workspacePatterns = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces?.packages ?? []);

  const packageDirs = workspacePatterns
    .filter((pattern) => pattern.endsWith("/*"))
    .map((pattern) => pattern.replace("/*", ""))
    .filter((dir) => !dir.startsWith("apps"));

  // Get available packages
  const packages: PackageInfo[] = [];
  const nestedDirs = packageDirs.filter((dir) => dir.includes("/"));

  for (const dir of packageDirs) {
    if (existsSync(dir)) {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
        .filter((d) => !nestedDirs.some((nested) => nested === join(dir, d.name)));

      for (const entry of entries) {
        packages.push({
          name: entry.name,
          dir,
          path: join(dir, entry.name),
        });
      }
    }
  }

  if (packages.length === EMPTY) {
    throw new Error("No packages found");
  }

  // Get package to remove
  let selectedPackage: PackageInfo | undefined = undefined;

  if (options.name) {
    selectedPackage = packages.find((pkg) => pkg.name === options.name);

    if (!selectedPackage) {
      throw new Error(`Package not found: ${options.name}`);
    }
  } else {
    if (!IS_INTERACTIVE) {
      throw new Error("Package name is required in non-interactive mode");
    }

    const result = await p.select({
      message: "Select package to remove",
      options: packages.map((pkg) => ({
        value: pkg,
        label: `${pkg.path}`,
      })),
    });

    if (p.isCancel(result)) {
      p.cancel("Cancelled");
      process.exit(EXIT_SUCCESS);
    }

    selectedPackage = result;
  }

  const targetDir = selectedPackage.path;

  // Confirm
  if (!force) {
    const confirmed = await p.confirm({
      message: `Delete ${targetDir}?`,
      initialValue: false,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled");
      process.exit(EXIT_SUCCESS);
    }
  }

  // Remove package
  const s = p.spinner();

  s.start("Removing package");

  await $`rm -rf ${targetDir}`.quiet();

  s.stop("Package removed");

  // Update root tsconfig references
  const rootTsConfigPath = "tsconfig.json";

  if (existsSync(rootTsConfigPath)) {
    try {
      const content = await Bun.file(rootTsConfigPath).text();
      const config = JSON.parse(content);

      if (Array.isArray(config.references)) {
        const originalLength = config.references.length;

        config.references = config.references.filter(
          (ref: { path: string }) => ref.path !== targetDir,
        );

        if (config.references.length < originalLength) {
          await Bun.write(rootTsConfigPath, `${JSON.stringify(config, null, JSON_INDENT)}\n`);
          p.log.success("Updated tsconfig.json references");
        }
      }
    } catch {
      p.log.warn("Could not update tsconfig.json (update manually)");
    }
  }

  if (!silent) {
    p.outro(`Removed ${selectedPackage.name}`);
  }
}
