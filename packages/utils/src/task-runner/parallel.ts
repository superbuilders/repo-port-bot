import { isInteractive, SpinnerGroup } from "../run-step";
import { formatTaskResultText } from "../run-step/format.ts";
import { runCommand } from "./command.ts";

import type { TaskDef, TaskResult } from "./types.ts";

const CHECK_MARK = "\u2714";
const CROSS_MARK = "\u2716";

type ShellError = Error &
  Readonly<{
    exitCode: number;
    stderr: Buffer;
    stdout: Buffer;
  }>;

type TaskOutcome = Readonly<{
  error?: unknown;
  label: string;
  result: TaskResult;
  task: TaskDef;
}>;

/**
 * Get the display label for a task (custom name or id).
 *
 * @param task - Task definition.
 * @returns Human-readable task label.
 */
function getTaskLabel(task: TaskDef): string {
  const customName = task.name?.trim();

  if (customName) {
    return customName;
  }

  return task.id;
}

/**
 * Execute one command task with optional cancellation signal.
 *
 * @param task - Task definition to execute.
 * @param signal - Optional abort signal.
 */
async function executeTask(task: TaskDef, signal?: AbortSignal): Promise<void> {
  await runCommand(task.command, task.timeoutMs, signal);
}

/**
 * Check whether an error contains shell process output.
 *
 * @param error - Value to test.
 * @returns True when error is a shell-process failure shape.
 */
function isShellError(error: unknown): error is ShellError {
  return error instanceof Error && "exitCode" in error && "stderr" in error && "stdout" in error;
}

/**
 * Print captured shell command diagnostics.
 *
 * @param error - Shell error with buffered stdout/stderr.
 */
function logShellError(error: ShellError): void {
  console.error(`  Exit Code: ${String(error.exitCode)}`);

  const stdout = error.stdout.toString().trim();
  const stderr = error.stderr.toString().trim();

  if (stdout) {
    console.error("  Stdout:");
    console.error(
      stdout
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
  }

  if (stderr) {
    console.error("  Stderr:");
    console.error(
      stderr
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
  }
}

/**
 * Print deterministic non-interactive output for parallel task outcomes.
 *
 * @param outcomes - Task outcomes in definition order.
 */
function printNonInteractiveParallelOutcomes(outcomes: readonly TaskOutcome[]): void {
  for (const outcome of outcomes) {
    const symbol = outcome.result.ok ? CHECK_MARK : CROSS_MARK;
    const text = formatTaskResultText({
      durationMs: outcome.result.durationMs,
      includeFailurePrefix: true,
      label: outcome.label,
      ok: outcome.result.ok,
    });

    console.log(`${symbol} ${text}`);
  }
}

/**
 * Execute a parallel task group with fail-fast cancellation.
 *
 * @param tasks - Task group to execute concurrently.
 * @returns Task outcomes in definition order.
 */
export async function executeParallelTasks(tasks: readonly TaskDef[]): Promise<TaskOutcome[]> {
  const labels = tasks.map(getTaskLabel);
  const interactive = isInteractive();
  const spinnerGroup = interactive ? new SpinnerGroup(labels) : undefined;
  const controllers = tasks.map(() => new AbortController());
  const settled = tasks.map(() => false);
  let cancellationTriggered = false;

  spinnerGroup?.start();

  const outcomes = await Promise.all(
    tasks.map(async (task, index): Promise<TaskOutcome> => {
      const label = labels[index] ?? task.id;
      const startedAt = Date.now();

      try {
        await executeTask(task, controllers[index]?.signal);

        const result: TaskResult = {
          durationMs: Date.now() - startedAt,
          id: task.id,
          ok: true,
        };

        spinnerGroup?.update(
          index,
          "success",
          formatTaskResultText({
            durationMs: result.durationMs,
            label,
            ok: true,
          }),
        );
        settled[index] = true;

        return { label, result, task };
      } catch (error) {
        const result: TaskResult = {
          durationMs: Date.now() - startedAt,
          id: task.id,
          ok: false,
        };

        spinnerGroup?.update(
          index,
          "error",
          formatTaskResultText({
            durationMs: result.durationMs,
            label,
            ok: false,
          }),
        );
        settled[index] = true;

        if (task.allowFailure !== true && cancellationTriggered === false) {
          cancellationTriggered = true;

          for (
            let controllerIndex = 0;
            controllerIndex < controllers.length;
            controllerIndex += 1
          ) {
            if (controllerIndex !== index && settled[controllerIndex] !== true) {
              controllers[controllerIndex]?.abort();
            }
          }
        }

        return { error, label, result, task };
      }
    }),
  );

  spinnerGroup?.stop();

  if (!interactive) {
    printNonInteractiveParallelOutcomes(outcomes);
  }

  for (const outcome of outcomes) {
    if (!outcome.result.ok && outcome.task.allowFailure === true) {
      console.error(`Warning: task failed but allowFailure=true (${outcome.label})`);

      if (isShellError(outcome.error)) {
        logShellError(outcome.error);
      } else {
        console.error(
          `  ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
        );
      }
    }
  }

  const failure = outcomes.find(
    (outcome) => outcome.result.ok === false && outcome.task.allowFailure !== true,
  );

  if (failure !== undefined) {
    if (isShellError(failure.error)) {
      logShellError(failure.error);
    }

    throw new Error(`task failed: ${failure.label}`);
  }

  return outcomes;
}
