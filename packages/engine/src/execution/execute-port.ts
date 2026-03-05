import { isAbsolute, relative } from 'node:path'

import {
	createConsoleLogger,
	formatPortBotExecuteAttemptLine,
	formatPortBotLine,
} from '@repo-port-bot/logger'

import { extractFilePath, joinNonEmptyLines, toErrorMessage, truncateLogText } from '../utils.ts'
import { runValidationCommands } from './run-validation.ts'
import { buildValidationFailureReason } from './utils.ts'

import type { Logger } from '@repo-port-bot/logger'

import type {
	AgentMessage,
	AgentProvider,
	ExecutionAttempt,
	ExecutionResult,
	PortContext,
	ValidationCommandResult,
} from '../types.ts'

type ValidationRunner = (options: {
	commands: string[]
	workingDirectory: string
}) => Promise<ValidationCommandResult[]>

interface ExecutePortOptions {
	agentProvider: AgentProvider
	context: PortContext
	maxAttempts?: number
	targetWorkingDirectory: string
	sourceWorkingDirectory?: string
	diffFilePath?: string
	logger?: Logger
	validate?: ValidationRunner
}

const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Run the execution stage (agent edit -> validate -> retry).
 *
 * @param options - Execution orchestrator options.
 * @param options.agentProvider - Agent backend implementation.
 * @param options.context - Port run context.
 * @param options.maxAttempts - Retry budget. Defaults to 3.
 * @param options.targetWorkingDirectory - Writable target repo path.
 * @param options.sourceWorkingDirectory - Optional source repo checkout path.
 * @param options.diffFilePath - Optional source diff file path.
 * @returns Execution result with history and success/failure state.
 */
export async function executePort(options: ExecutePortOptions): Promise<ExecutionResult> {
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
	const logger = options.logger ?? createConsoleLogger('info')
	const validate = options.validate ?? runValidationCommands

	if (maxAttempts < 1) {
		throw new Error('`maxAttempts` must be greater than or equal to 1.')
	}

	const executionStartedAtMs = Date.now()
	const history: ExecutionAttempt[] = []
	const touchedFiles = new Set<string>()
	let agentModel: string | undefined = undefined

	for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
		const attemptStartedAtMs = Date.now()

		logger.group(`Attempt ${String(attemptNumber)}/${String(maxAttempts)}`)

		try {
			try {
				const agentOutput = await options.agentProvider.executePort({
					files: options.context.sourceChange.files,
					targetWorkingDirectory: options.targetWorkingDirectory,
					sourceWorkingDirectory: options.sourceWorkingDirectory,
					diffFilePath: options.diffFilePath,
					pluginConfig: options.context.pluginConfig,
					previousAttempts: history,
					onMessage: message => {
						logAgentMessage({
							logger,
							runId: options.context.runId,
							message,
							targetWorkingDirectory: options.targetWorkingDirectory,
							sourceWorkingDirectory: options.sourceWorkingDirectory,
						})
					},
				})

				agentModel ??= agentOutput.model

				for (const path of agentOutput.touchedFiles) {
					touchedFiles.add(path)
				}

				const validation = await validate({
					commands: options.context.pluginConfig.validationCommands,
					workingDirectory: options.targetWorkingDirectory,
				})

				const attemptNotes = joinNonEmptyLines([
					agentOutput.notes,
					agentOutput.complete ? undefined : 'Agent marked attempt as incomplete.',
				])

				const attempt: ExecutionAttempt = {
					attempt: attemptNumber,
					touchedFiles: agentOutput.touchedFiles,
					validation,
					notes: attemptNotes,
					toolCallLog: agentOutput.toolCallLog,
				}

				history.push(attempt)

				const allValidationPassed = validation.every(result => result.ok)

				logger.debug(JSON.stringify(validation, null, 2))

				for (const toolCall of attempt.toolCallLog) {
					logger.debug(
						formatPortBotLine({
							runId: options.context.runId,
							fields: {
								stage: 'execute',
								tool: toolCall.toolName,
								toolDurationMs: toolCall.durationMs,
							},
						}),
					)
				}

				logger.info(
					formatPortBotExecuteAttemptLine({
						runId: options.context.runId,
						attempt: attemptNumber,
						maxAttempts,
						touched: attempt.touchedFiles.length,
						validation: allValidationPassed ? 'pass' : 'fail',
						durationMs: Math.max(1, Date.now() - attemptStartedAtMs),
					}),
				)

				if (allValidationPassed) {
					return {
						success: true,
						attempts: history.length,
						history,
						touchedFiles: [...touchedFiles],
						model: agentModel,
						durationMs: Date.now() - executionStartedAtMs,
					}
				}

				if (attemptNumber === maxAttempts) {
					return {
						success: false,
						attempts: history.length,
						history,
						touchedFiles: [...touchedFiles],
						failureReason: buildValidationFailureReason(validation, history.length),
						model: agentModel,
						durationMs: Date.now() - executionStartedAtMs,
					}
				}
			} catch (error) {
				const errorMessage = toErrorMessage(error)
				const attempt: ExecutionAttempt = {
					attempt: attemptNumber,
					touchedFiles: [],
					validation: [],
					notes: `Agent provider error: ${errorMessage}`,
					toolCallLog: [],
				}

				history.push(attempt)

				logger.info(
					formatPortBotExecuteAttemptLine({
						runId: options.context.runId,
						attempt: attemptNumber,
						maxAttempts,
						touched: 0,
						validation: 'error',
						durationMs: Math.max(1, Date.now() - attemptStartedAtMs),
					}),
				)
				logger.warn(
					formatPortBotLine({
						runId: options.context.runId,
						fields: {
							stage: 'execute',
							error: `agent provider failed on attempt ${String(attemptNumber)}: ${errorMessage}`,
						},
					}),
				)

				return {
					success: false,
					attempts: history.length,
					history,
					touchedFiles: [...touchedFiles],
					failureReason: `Agent provider failed on attempt ${String(attemptNumber)}: ${errorMessage}`,
					model: agentModel,
					durationMs: Date.now() - executionStartedAtMs,
				}
			}
		} finally {
			logger.groupEnd()
		}
	}

	return {
		success: false,
		attempts: history.length,
		history,
		touchedFiles: [...touchedFiles],
		failureReason: `Execution stopped before completing after ${String(history.length)} attempts.`,
	}
}

/**
 * Log one streamed agent message using structured line formatting.
 *
 * @param input - Message logging input.
 * @param input.logger - Logger implementation.
 * @param input.runId - Run identifier for correlation.
 * @param input.message - Streamed agent message.
 * @param input.targetWorkingDirectory - Optional target repo root for path normalization.
 * @param input.sourceWorkingDirectory - Optional source repo root for path normalization.
 */
function logAgentMessage(input: {
	logger: Logger
	runId: string
	message: AgentMessage
	targetWorkingDirectory?: string
	sourceWorkingDirectory?: string
}): void {
	const { logger, runId, message } = input

	if (message.kind === 'tool_start') {
		const loggedFilePath = normalizeLoggedFilePath({
			filePath: extractFilePath(message.toolInput),
			targetWorkingDirectory: input.targetWorkingDirectory,
			sourceWorkingDirectory: input.sourceWorkingDirectory,
		})

		logger.info(
			formatPortBotLine({
				runId,
				fields: {
					stage: 'execute',
					tool: message.toolName,
					file: loggedFilePath,
				},
			}),
		)

		return
	}

	if (message.kind === 'tool_end') {
		logger.debug(
			formatPortBotLine({
				runId,
				fields: {
					stage: 'execute',
					tool: message.toolName,
					toolDurationMs: message.durationMs,
				},
			}),
		)

		return
	}

	logger.debug(
		formatPortBotLine({
			runId,
			fields: {
				stage: 'execute',
				[message.kind]: truncateLogText(message.text),
			},
		}),
	)
}

/**
 * Normalize logged file paths to source/target-relative values when possible.
 *
 * @param input - Path normalization input.
 * @param input.filePath - Candidate raw path from tool input.
 * @param input.targetWorkingDirectory - Optional target repo root.
 * @param input.sourceWorkingDirectory - Optional source repo root.
 * @returns Relative path when inside known roots, else original path.
 */
function normalizeLoggedFilePath(input: {
	filePath: string | undefined
	targetWorkingDirectory?: string
	sourceWorkingDirectory?: string
}): string | undefined {
	const filePath = input.filePath

	if (!filePath || !isAbsolute(filePath)) {
		return filePath
	}

	for (const root of [input.targetWorkingDirectory, input.sourceWorkingDirectory]) {
		if (root) {
			const relativePath = relative(root, filePath)

			if (relativePath && !relativePath.startsWith('..')) {
				return relativePath
			}
		}
	}

	return filePath
}
