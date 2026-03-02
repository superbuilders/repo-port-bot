#!/usr/bin/env bun
/**
 * Examples CLI — discover and run local development examples.
 *
 * All commands except `list` and `setup` forward to `packages/cli`
 * with cwd set to the example directory. The hbot CLI picks up
 * `hbot.json` from cwd automatically.
 *
 * Usage:
 *   bun run example list
 *   bun run example <id> setup
 *   bun run example <id> [hbot args...]
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import * as p from "@clack/prompts";
import { runStep } from "@repo-port-bot/utils";
import { $ } from "bun";
import { Command } from "commander";

interface BootstrapFile {
  from: string;
  to: string;
}

interface ExampleManifest {
  id: string;
  name: string;
  description: string;
  cwd: string;
  requiredFiles?: string[];
  bootstrapFiles?: BootstrapFile[];
}

const CLI_ENTRY = resolve(import.meta.dir, "../../../packages/cli/src/index.ts");
const EXIT_FAILURE = 1;
const EXIT_SUCCESS = 0;
const ROOT_DIR = resolve(import.meta.dir, "../../..");
const EXAMPLES_DIR = join(ROOT_DIR, "examples");
const DEFAULT_HBOT_COMMAND = "dev";

const INTERACTIVE_COMMANDS = [
  { value: "setup", label: "setup", hint: "prepare local files from templates" },
  { value: "dev", label: "dev", hint: "boot in development mode" },
  { value: "config", label: "config", hint: "print resolved configuration" },
  { value: "logs", label: "logs", hint: "tail daemon logs" },
];

/**
 * Parse and validate an example manifest.
 *
 * @param raw - Untrusted manifest JSON.
 * @param manifestPath - Manifest file path for diagnostics.
 * @returns Parsed example manifest.
 */
function parseManifest(raw: unknown, manifestPath: string): ExampleManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid example manifest at ${manifestPath}: expected object`);
  }

  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : null;
  const name = typeof value.name === "string" && value.name.length > 0 ? value.name : null;
  const description =
    typeof value.description === "string" && value.description.length > 0
      ? value.description
      : null;
  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : null;

  if (!id || !name || !description || !cwd) {
    throw new Error(`Invalid example manifest at ${manifestPath}`);
  }

  let requiredFiles: string[] | undefined = undefined;

  if (Array.isArray(value.requiredFiles)) {
    requiredFiles = [];

    for (const entry of value.requiredFiles) {
      if (typeof entry === "string") {
        requiredFiles.push(entry);
      }
    }
  }

  let bootstrapFiles: BootstrapFile[] | undefined = undefined;

  if (Array.isArray(value.bootstrapFiles)) {
    bootstrapFiles = [];

    for (const entry of value.bootstrapFiles) {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const from = record.from;
        const to = record.to;

        if (typeof from === "string" && typeof to === "string") {
          bootstrapFiles.push({ from, to });
        }
      }
    }
  }

  return {
    id,
    name,
    description,
    cwd,
    requiredFiles,
    bootstrapFiles,
  };
}

/**
 * Discover all example manifests under "examples/<name>/example.json".
 *
 * @returns Sorted example manifests.
 */
async function loadExamples(): Promise<ExampleManifest[]> {
  const entries = await readdir(EXAMPLES_DIR, { withFileTypes: true });
  const manifests: ExampleManifest[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const manifestPath = join(EXAMPLES_DIR, entry.name, "example.json");

      if (existsSync(manifestPath)) {
        const manifest = parseManifest(await Bun.file(manifestPath).json(), manifestPath);

        manifests.push(manifest);
      }
    }
  }

  return manifests.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Look up an example by id.
 *
 * @param examples - Loaded examples.
 * @param exampleId - Example id.
 * @returns Matching example manifest.
 */
function findExample(examples: readonly ExampleManifest[], exampleId: string): ExampleManifest {
  const example = examples.find((entry) => entry.id === exampleId);

  if (!example) {
    const ids = examples.map((entry) => entry.id).join(", ") || "(none)";

    throw new Error(`Unknown example "${exampleId}". Available examples: ${ids}`);
  }

  return example;
}

/**
 * Render a human-readable examples list.
 *
 * @param examples - Loaded examples.
 */
function listExamples(examples: readonly ExampleManifest[]): void {
  if (examples.length === 0) {
    p.log.warn("No examples found. Add example.json under examples/<name>.");

    return;
  }

  const lines = examples
    .map((example) => {
      const relPath = relative(ROOT_DIR, join(ROOT_DIR, example.cwd));

      return `${example.id}\n${example.description}\npath: ${relPath}`;
    })
    .join("\n\n");

  p.note(lines, `${examples.length} example(s)`);
}

/**
 * Create missing local files from each example's templates.
 *
 * @param example - Example to bootstrap.
 */
async function runBootstrap(example: ExampleManifest): Promise<void> {
  const cwd = join(ROOT_DIR, example.cwd);
  const bootstrapFiles = example.bootstrapFiles ?? [];

  if (bootstrapFiles.length === 0) {
    p.log.info(`No setup steps for "${example.id}".`);

    return;
  }

  let created = 0;
  let skipped = 0;

  for (const file of bootstrapFiles) {
    const fromPath = join(cwd, file.from);
    const toPath = join(cwd, file.to);

    if (!existsSync(fromPath)) {
      throw new Error(`Setup source file not found: ${relative(ROOT_DIR, fromPath)}`);
    }

    if (existsSync(toPath)) {
      skipped += 1;
    } else {
      await Bun.write(toPath, Bun.file(fromPath));
      created += 1;
    }
  }

  p.log.success(
    `Setup complete for "${example.id}" (${created} created, ${skipped} already existed).`,
  );
}

/**
 * Ensure required local files exist before running example commands.
 *
 * @param example - Example to validate.
 */
function validateRequiredFiles(example: ExampleManifest): void {
  const requiredFiles = example.requiredFiles ?? [];
  const cwd = join(ROOT_DIR, example.cwd);
  const missingFiles = requiredFiles
    .map((file) => join(cwd, file))
    .filter((path) => !existsSync(path))
    .map((path) => relative(ROOT_DIR, path));

  if (missingFiles.length === 0) {
    return;
  }

  throw new Error(
    [
      `Missing required files for "${example.id}":`,
      ...missingFiles.map((file) => `- ${file}`),
      `Run: bun run example ${example.id} setup`,
    ].join("\n"),
  );
}

/**
 * Forward args to the hbot CLI in the example's working directory.
 *
 * @param example - Example manifest.
 * @param hbotArgs - Arguments forwarded to the hbot CLI.
 */
async function runHbotCommand(
  example: ExampleManifest,
  hbotArgs: readonly string[],
): Promise<void> {
  validateRequiredFiles(example);
  await buildWorkspaceForExample();

  const cwd = join(ROOT_DIR, example.cwd);

  const proc = Bun.spawn(["bun", CLI_ENTRY, ...hbotArgs], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== EXIT_SUCCESS) {
    process.exit(exitCode);
  }
}

/**
 * Build the workspace before running an example command.
 */
async function buildWorkspaceForExample(): Promise<void> {
  console.log("");
  await runStep(
    "Building workspace...",
    async () => {
      await $`bun run build`.cwd(ROOT_DIR).quiet();
    },
    "Workspace built",
  );
  console.log("");
}

/**
 * Interactive mode for selecting an example and command.
 *
 * @param examples - Loaded examples.
 */
async function interactive(examples: readonly ExampleManifest[]): Promise<void> {
  if (examples.length === 0) {
    p.log.warn("No examples found. Add example.json under examples/<name>.");

    return;
  }

  console.log("");

  p.intro("Examples");

  const selectedExampleId = await p.select({
    message: "Which example do you want to run?",
    options: examples.map((example) => ({
      value: example.id,
      label: example.id,
      hint: example.description,
    })),
  });

  if (p.isCancel(selectedExampleId)) {
    p.cancel("Cancelled");
    process.exit(EXIT_SUCCESS);
  }

  const example = findExample(examples, selectedExampleId);
  const selectedCommand = await p.select({
    message: `Command for ${example.id}`,
    options: INTERACTIVE_COMMANDS,
  });

  if (p.isCancel(selectedCommand)) {
    p.cancel("Cancelled");
    process.exit(EXIT_SUCCESS);
  }

  await (selectedCommand === "setup"
    ? runBootstrap(example)
    : runHbotCommand(example, [selectedCommand]));

  p.outro("Done");
}

/**
 * Build and run the examples CLI program.
 */
async function main(): Promise<void> {
  const program = new Command()
    .name("example")
    .description("Discover and run local development examples")
    .enablePositionalOptions()
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ bun run example list",
        "  $ bun run example gchat setup",
        "  $ bun run example gchat dev",
        "  $ bun run example discord dev --webhook-port 9090",
      ].join("\n"),
    );

  program
    .command("list")
    .description("List available examples")
    .action(async () => {
      const examples = await loadExamples();

      listExamples(examples);
    });

  program
    .command("run", { isDefault: true })
    .description("Run an hbot command in an example project")
    .argument("[args...]", "example-id [hbot args...]")
    .passThroughOptions()
    .action(async (args: string[]) => {
      const examples = await loadExamples();
      const [exampleId, ...hbotArgs] = args;

      if (!exampleId) {
        await interactive(examples);

        return;
      }

      const example = findExample(examples, exampleId);

      if (hbotArgs[0] === "setup") {
        await runBootstrap(example);

        return;
      }

      await runHbotCommand(example, hbotArgs.length > 0 ? hbotArgs : [DEFAULT_HBOT_COMMAND]);
    });

  await program.parseAsync();
}

try {
  await main();
} catch (error) {
  console.error("");
  console.error(error instanceof Error ? error.message : "unknown error");
  process.exit(EXIT_FAILURE);
}
