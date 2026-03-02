import { runStep } from "../run-step";
import { runCommand } from "./command.ts";
import { executeParallelTasks } from "./parallel.ts";

import type { TaskDef, TaskResult, TaskRunnerConfig, TaskStep } from "./types.ts";

/**
 * Get the display label for a task (custom name or id).
 *
 * @param task - Task definition
 * @returns Human-readable label for logging
 */
function getTaskLabel(task: TaskDef): string {
  const customName = task.name?.trim();

  if (customName) {
    return customName;
  }

  return task.id;
}

/**
 * Run a single command task.
 *
 * @param task - Task definition to execute
 */
async function executeTask(task: TaskDef): Promise<void> {
  await runCommand(task.command, task.timeoutMs);
}

/**
 * Determine whether a task step is a parallel group.
 *
 * @param step - Task step from config.
 * @returns True when step is a parallel group.
 */
function isParallelTaskStep(step: TaskStep): step is readonly TaskDef[] {
  return Array.isArray(step);
}

/**
 * Run all tasks from the config and collect results.
 *
 * Tasks are executed in order. Failures throw unless allowFailure is true.
 *
 * @param config - Parsed task-runner config
 * @returns Array of TaskResult for each task
 * @throws Error when a task fails (unless allowFailure is true)
 */
export async function runTasks(config: TaskRunnerConfig): Promise<TaskResult[]> {
  const results: TaskResult[] = [];

  for (const taskStep of config.tasks) {
    if (isParallelTaskStep(taskStep)) {
      const outcomes = await executeParallelTasks(taskStep);

      for (const outcome of outcomes) {
        results.push(outcome.result);
      }
    } else {
      const task = taskStep;
      const startMs = Date.now();
      const label = getTaskLabel(task);

      try {
        await runStep(`Running ${label}`, () => executeTask(task), `${label} complete`);
        results.push({
          durationMs: Date.now() - startMs,
          id: task.id,
          ok: true,
        });
      } catch (error) {
        if (task.allowFailure === true) {
          console.error(`Warning: task failed but allowFailure=true (${label})`);
          console.error(error instanceof Error ? error.message : String(error));
          results.push({
            durationMs: Date.now() - startMs,
            id: task.id,
            ok: false,
          });
        } else {
          results.push({
            durationMs: Date.now() - startMs,
            id: task.id,
            ok: false,
          });

          throw new Error(`task failed: ${label}`);
        }
      }
    }
  }

  return results;
}
