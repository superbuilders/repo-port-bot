export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export type LogFieldValue = boolean | number | string
export type LogFields = Record<string, LogFieldValue | undefined>

export type PortBotStage =
	| 'context'
	| 'config'
	| 'decision'
	| 'execute'
	| 'deliver'
	| 'notify'
	| 'outcome'

export type PortBotValidation = 'pass' | 'fail' | 'error'

export interface PortBotLineInput {
	runId: string
	fields: LogFields
}

export interface PortBotStageLineInput {
	runId: string
	stage: PortBotStage
	fields?: LogFields
}

export interface PortBotExecuteAttemptLineInput {
	runId: string
	attempt: number
	maxAttempts: number
	touched: number
	validation: PortBotValidation
	durationMs: number
}

export interface Logger {
	error(message: string, ...args: unknown[]): void
	warn(message: string, ...args: unknown[]): void
	info(message: string, ...args: unknown[]): void
	debug(message: string, ...args: unknown[]): void
	group(label: string): void
	groupEnd(): void
}
