import type {
	LogFields,
	LogLevel,
	Logger,
	PortBotExecuteAttemptLineInput,
	PortBotLineInput,
	PortBotStageLineInput,
} from './types.ts'

export type {
	LogFieldValue,
	LogFields,
	LogLevel,
	Logger,
	PortBotExecuteAttemptLineInput,
	PortBotLineInput,
	PortBotStage,
	PortBotStageLineInput,
	PortBotValidation,
} from './types.ts'

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
}

/**
 * Check whether a log entry is enabled for the current logger level.
 *
 * @param currentLevel - Minimum enabled level.
 * @param entryLevel - Entry level being emitted.
 * @returns True when the entry should be emitted.
 */
export function shouldLog(currentLevel: LogLevel, entryLevel: LogLevel): boolean {
	return LOG_LEVEL_PRIORITY[entryLevel] <= LOG_LEVEL_PRIORITY[currentLevel]
}

/**
 * Format key/value fields into a deterministic token list.
 *
 * @param fields - Structured log fields.
 * @returns Space-separated key/value pairs.
 */
function formatFields(fields: LogFields): string {
	return Object.entries(fields)
		.filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(' ')
}

/**
 * Build a canonical repo-port-bot log line.
 *
 * @param input - Log line input.
 * @returns Formatted log line.
 */
export function formatPortBotLine(input: PortBotLineInput): string {
	const fieldText = formatFields(input.fields)

	return fieldText.length > 0
		? `[port-bot] run=${input.runId} ${fieldText}`
		: `[port-bot] run=${input.runId}`
}

/**
 * Build a canonical stage transition log line.
 *
 * @param input - Stage log input.
 * @returns Formatted log line.
 */
export function formatPortBotStageLine(input: PortBotStageLineInput): string {
	return formatPortBotLine({
		runId: input.runId,
		fields: {
			stage: input.stage,
			...input.fields,
		},
	})
}

/**
 * Build a canonical execute-attempt log line.
 *
 * @param input - Execute attempt input.
 * @returns Formatted log line.
 */
export function formatPortBotExecuteAttemptLine(input: PortBotExecuteAttemptLineInput): string {
	return formatPortBotLine({
		runId: input.runId,
		fields: {
			stage: 'execute',
			attempt: `${String(input.attempt)}/${String(input.maxAttempts)}`,
			touched: input.touched,
			validation: input.validation,
			durationMs: input.durationMs,
		},
	})
}

/**
 * Create a logger that writes to `console.*`.
 *
 * @param level - Minimum enabled level.
 * @returns Level-filtered logger implementation.
 */
export function createConsoleLogger(level: LogLevel): Logger {
	return {
		error(message, ...args) {
			if (!shouldLog(level, 'error')) {
				return
			}

			console.error(message, ...args)
		},
		warn(message, ...args) {
			if (!shouldLog(level, 'warn')) {
				return
			}

			console.warn(message, ...args)
		},
		info(message, ...args) {
			if (!shouldLog(level, 'info')) {
				return
			}

			console.info(message, ...args)
		},
		debug(message, ...args) {
			if (!shouldLog(level, 'debug')) {
				return
			}

			console.debug(message, ...args)
		},
		group(label) {
			if (!shouldLog(level, 'debug')) {
				return
			}

			console.group(label)
		},
		groupEnd() {
			if (!shouldLog(level, 'debug')) {
				return
			}

			console.groupEnd()
		},
	}
}
