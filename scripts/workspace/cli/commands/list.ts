#!/usr/bin/env bun
/**
 * List all packages in the monorepo.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import * as p from "@clack/prompts";

import type { ListOptions, ListPackageInfo, PackageJson } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PkgJson {
  name?: string;
  version?: string;
  private?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Main Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all packages in the monorepo.
 *
 * @param options - List options
 * @returns Array of package info objects
 */
export async function list(options: ListOptions = {}): Promise<ListPackageInfo[]> {
  const { silent = false } = options;

  const rootPkg: PackageJson = await Bun.file("package.json").json();
  const workspacePatterns = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces?.packages ?? []);

  const packageDirs = workspacePatterns
    .filter((pattern) => pattern.endsWith("/*"))
    .map((pattern) => pattern.replace("/*", ""));

  const packages: ListPackageInfo[] = [];
  const nestedDirs = packageDirs.filter((dir) => dir.includes("/"));

  for (const dir of packageDirs) {
    if (existsSync(dir)) {
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
        .filter((d) => !nestedDirs.some((nested) => nested === join(dir, d.name)));

      for (const entry of entries) {
        const pkgPath = join(dir, entry.name);
        const pkgJsonPath = join(pkgPath, "package.json");

        if (existsSync(pkgJsonPath)) {
          const pkg: PkgJson = await Bun.file(pkgJsonPath).json();

          packages.push({
            path: pkgPath,
            name: pkg.name ?? "(unnamed)",
            version: pkg.version ?? "-",
            private: pkg.private ? "✓" : "",
          });
        }
      }
    }
  }

  if (!silent) {
    if (packages.length === EMPTY) {
      p.log.warn("No packages found.");
    } else {
      const lines = packages
        .map((pkg) => {
          const priv = pkg.private ? " (private)" : "";

          return `${pkg.name}@${pkg.version}${priv}\n${pkg.path}`;
        })
        .join("\n\n");

      p.note(lines, `${packages.length} package(s)`);
    }
  }

  return packages;
}
