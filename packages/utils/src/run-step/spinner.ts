import { blue, dim, green, red } from "colorette";

import type { TaskStatus } from "./types.ts";

const SPINNER_INTERVAL_MS = 80;
const STARTING_FRAME_INDEX = 0;
const NEXT_FRAME_STEP = 1;
const CHECK_MARK = "\u2714";
const CROSS_MARK = "\u2716";
const CANCEL_MARK = "\u25CB";
const ANSI_CLEAR_LINE = "\u001B[2K";
const ANSI_CURSOR_HIDE = "\u001B[?25l";
const ANSI_CURSOR_SHOW = "\u001B[?25h";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Check if stdout is a TTY (interactive terminal).
 *
 * @returns True if output is to a terminal
 */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Format a single spinner line for display.
 *
 * @param status - Current task status
 * @param text - Label text
 * @param frame - Spinner frame character (when running)
 * @returns Formatted line string
 */
function formatSpinnerLine(status: TaskStatus, text: string, frame: string): string {
  if (status === "running") {
    return `${blue(frame)} ${text}`;
  }

  if (status === "success") {
    return `${green(CHECK_MARK)} ${text}`;
  }

  if (status === "error") {
    return `${red(CROSS_MARK)} Failed: ${text}`;
  }

  if (status === "cancelled") {
    return `${dim(CANCEL_MARK)} Cancelled: ${dim(text)}`;
  }

  return text;
}

/**
 * Move cursor up by a fixed number of lines.
 *
 * @param lineCount - Number of lines to move up.
 * @returns ANSI cursor-up sequence.
 */
function cursorUp(lineCount: number): string {
  return `\u001B[${String(lineCount)}A`;
}

/**
 * Terminal spinner for long-running tasks.
 *
 * Shows animated frame when running, check/cross on success/error.
 * No-ops when stdout is not a TTY.
 */
export class Spinner {
  private frameIndex = STARTING_FRAME_INDEX;
  private intervalId: ReturnType<typeof globalThis.setInterval> | undefined = undefined;
  private lineWasRendered = false;
  private status: TaskStatus = "pending";
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  /**
   * Start the spinner animation.
   */
  start(): void {
    if (!isInteractive()) {
      return;
    }

    process.stdout.write(ANSI_CURSOR_HIDE);
    this.status = "running";
    this.render();
    this.intervalId = globalThis.setInterval(() => {
      this.frameIndex = (this.frameIndex + NEXT_FRAME_STEP) % SPINNER_FRAMES.length;

      this.render();
    }, SPINNER_INTERVAL_MS);
  }

  /**
   * Update status and optionally the display text.
   *
   * @param status - New status (running, success, error)
   * @param text - Optional new label text
   */
  update(status: TaskStatus, text?: string): void {
    this.status = status;

    if (text) {
      this.text = text;
    }
  }

  /**
   * Stop the spinner and show final state.
   */
  stop(): void {
    if (this.intervalId) {
      globalThis.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (!isInteractive()) {
      return;
    }

    this.render();
    process.stdout.write(ANSI_CURSOR_SHOW);
  }

  /**
   * Clear the spinner line without showing final state.
   */
  clear(): void {
    if (this.intervalId) {
      globalThis.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (isInteractive() && this.lineWasRendered) {
      process.stdout.write(`\r${ANSI_CLEAR_LINE}`);
      process.stdout.write(ANSI_CURSOR_SHOW);
      this.lineWasRendered = false;
    }
  }

  private render(): void {
    const line = formatSpinnerLine(this.status, this.text, SPINNER_FRAMES[this.frameIndex] ?? " ");

    process.stdout.write(`\r${ANSI_CLEAR_LINE}${line}`);

    if (this.status === "success" || this.status === "error") {
      process.stdout.write("\n");
    }

    this.lineWasRendered = true;
  }
}

/**
 * Multi-line spinner manager for concurrent task groups.
 *
 * Each item is rendered on its own line and updated in-place while running.
 */
export class SpinnerGroup {
  private entries: {
    status: TaskStatus;
    text: string;
  }[] = [];

  private frameIndex = STARTING_FRAME_INDEX;
  private hasRendered = false;
  private intervalId: ReturnType<typeof globalThis.setInterval> | undefined = undefined;

  constructor(labels: readonly string[]) {
    this.entries = labels.map((label) => ({
      status: "pending",
      text: label,
    }));
  }

  /**
   * Start group animation.
   */
  start(): void {
    if (!isInteractive() || this.entries.length === 0) {
      return;
    }

    process.stdout.write(ANSI_CURSOR_HIDE);
    this.entries = this.entries.map((entry) => ({
      ...entry,
      status: "running",
    }));
    this.render();
    this.intervalId = globalThis.setInterval(() => {
      this.frameIndex = (this.frameIndex + NEXT_FRAME_STEP) % SPINNER_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL_MS);
  }

  /**
   * Update one line in the group.
   *
   * @param index - Entry index.
   * @param status - Entry status.
   * @param text - Optional replacement text.
   */
  update(index: number, status: TaskStatus, text?: string): void {
    const entry = this.entries[index];

    if (!entry) {
      return;
    }

    entry.status = status;

    if (text !== undefined) {
      entry.text = text;
    }

    if (isInteractive()) {
      this.render();
    }
  }

  /**
   * Stop animation and keep final rendered lines.
   */
  stop(): void {
    if (this.intervalId !== undefined) {
      globalThis.clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (!isInteractive()) {
      return;
    }

    if (this.entries.length > 0) {
      this.render();
    }

    process.stdout.write(ANSI_CURSOR_SHOW);
  }

  private render(): void {
    if (!isInteractive() || this.entries.length === 0) {
      return;
    }

    if (this.hasRendered) {
      process.stdout.write(cursorUp(this.entries.length));
    }

    const frame = SPINNER_FRAMES[this.frameIndex] ?? " ";

    for (const entry of this.entries) {
      const line = formatSpinnerLine(entry.status, entry.text, frame);

      process.stdout.write(`\r${ANSI_CLEAR_LINE}${line}\n`);
    }

    this.hasRendered = true;
  }
}
