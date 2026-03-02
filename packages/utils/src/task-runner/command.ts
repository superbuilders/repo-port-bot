const SUCCESS_EXIT_CODE = 0;
const TIMEOUT_EXIT_CODE = -1;
const ABORT_EXIT_CODE = -2;

type CommandError = Error & {
  exitCode: number;
  stderr: Buffer;
  stdout: Buffer;
};

/**
 * Create an Error with attached shell output for failed command invocations.
 *
 * @param message - Error message
 * @param exitCode - Process exit code (or -1 for timeout)
 * @param stdout - Raw stdout bytes
 * @param stderr - Raw stderr bytes
 * @returns Error instance with exitCode, stdout, and stderr properties
 */
function createCommandError(
  message: string,
  exitCode: number,
  stdout: Uint8Array,
  stderr: Uint8Array,
): CommandError {
  const error = new Error(message) as CommandError;

  error.exitCode = exitCode;
  error.stdout = Buffer.from(stdout);
  error.stderr = Buffer.from(stderr);

  return error;
}

/**
 * Run a shell command and throw on non-zero exit or timeout.
 *
 * Uses `sh -lc` so the command runs in a login shell with full env.
 *
 * @param command - Command string to execute
 * @param timeoutMs - Optional timeout in milliseconds; process is killed if exceeded
 * @param signal - Optional abort signal for early cancellation
 * @throws CommandError when the command exits non-zero or times out
 */
export async function runCommand(
  command: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  const process = Bun.spawn(["sh", "-lc", command], {
    stderr: "pipe",
    stdout: "pipe",
  });
  let didTimeout = false;
  let didAbort = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined = undefined;
  let cleanupAbortListener: (() => void) | undefined = undefined;

  /**
   * Kill spawned process, ignoring errors from already-exited processes.
   */
  function killProcess(): void {
    try {
      process.kill();
    } catch {}
  }

  /**
   * Mark command as aborted and terminate process.
   */
  function abortProcess(): void {
    didAbort = true;
    killProcess();
  }

  if (signal?.aborted === true) {
    abortProcess();
  } else if (signal) {
    /**
     * Abort callback bound to the provided abort signal.
     */
    function onAbort(): void {
      abortProcess();
    }

    signal.addEventListener("abort", onAbort, { once: true });
    cleanupAbortListener = function cleanupAbortListenerFn(): void {
      signal.removeEventListener("abort", onAbort);
    };
  }

  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      didTimeout = true;
      killProcess();
    }, timeoutMs);
  }

  const [exitCode, stdoutData, stderrData] = await Promise.all([
    process.exited,
    new Response(process.stdout).bytes(),
    new Response(process.stderr).bytes(),
  ]);

  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }

  if (cleanupAbortListener !== undefined) {
    cleanupAbortListener();
  }

  if (exitCode !== SUCCESS_EXIT_CODE) {
    const timeoutSuffix = didTimeout ? ` (timed out after ${String(timeoutMs)}ms)` : "";
    const abortSuffix = didAbort ? " (aborted)" : "";
    let normalizedExitCode = exitCode;

    if (didTimeout) {
      normalizedExitCode = TIMEOUT_EXIT_CODE;
    } else if (didAbort) {
      normalizedExitCode = ABORT_EXIT_CODE;
    }

    throw createCommandError(
      `command failed with exit code ${String(exitCode)}${timeoutSuffix}${abortSuffix}`,
      normalizedExitCode,
      stdoutData,
      stderrData,
    );
  }
}
