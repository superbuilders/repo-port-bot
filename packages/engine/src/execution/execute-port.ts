import {
	createConsoleLogger,
	formatPortBotExecuteAttemptLine,
	formatPortBotLine,
} from '@repo-port-bot/logger'

import { joinNonEmptyLines, logAgentMessage, toErrorMessage } from '../utils.ts'
import { runValidationCommands } from './run-validation.ts'
import { buildValidationFailureReason } from './utils.ts'

import type { Logger } from '@repo-port-bot/logger'

import type {
	AgentProvider,
	ExecutePortAttemptResult,
	ExecutePortResult,
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
export async function executePort(options: ExecutePortOptions): Promise<ExecutePortResult> {
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
	const logger = options.logger ?? createConsoleLogger('info')
	const validate = options.validate ?? runValidationCommands

	if (maxAttempts < 1) {
		throw new Error('`maxAttempts` must be greater than or equal to 1.')
	}

	const executionStartedAtMs = Date.now()
	const attempts: ExecutePortAttemptResult[] = []
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
					previousAttempts: attempts,
					onMessage: message => {
						logAgentMessage({
							logger,
							runId: options.context.runId,
							stage: 'execute',
							message,
							targetWorkingDirectory: options.targetWorkingDirectory,
							sourceWorkingDirectory: options.sourceWorkingDirectory,
						})
					},
				})

				agentModel ??= agentOutput.trace.model

				for (const path of agentOutput.touchedFiles) {
					touchedFiles.add(path)
				}

				const validation = await validate({
					commands: options.context.pluginConfig.validationCommands,
					workingDirectory: options.targetWorkingDirectory,
				})

				const attemptNotes = joinNonEmptyLines([
					agentOutput.trace.notes,
					agentOutput.complete ? undefined : 'Agent marked attempt as incomplete.',
				])
				const attemptDurationMs = Math.max(1, Date.now() - attemptStartedAtMs)
				const allValidationPassed = validation.every(result => result.ok)

				const attempt: ExecutePortAttemptResult = {
					attempt: attemptNumber,
					status: allValidationPassed ? 'VALIDATED' : 'VALIDATION_FAILED',
					touchedFiles: agentOutput.touchedFiles,
					validation,
					trace: {
						notes: attemptNotes,
						durationMs: attemptDurationMs,
						toolCallLog: agentOutput.trace.toolCallLog,
						events: agentOutput.trace.events,
					},
				}

				attempts.push(attempt)

				logger.debug(JSON.stringify(validation, null, 2))

				for (const toolCall of attempt.trace.toolCallLog) {
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
						durationMs: attemptDurationMs,
					}),
				)

				if (allValidationPassed) {
					return {
						outcome: {
							status: 'SUCCEEDED',
							attempts: attempts.length,
							touchedFiles: [...touchedFiles],
						},
						trace: {
							model: agentModel,
							durationMs: Date.now() - executionStartedAtMs,
							notes: attemptNotes,
							toolCallLog: attempts.flatMap(entry => entry.trace.toolCallLog),
							events: attempts.flatMap(entry => entry.trace.events),
							attempts,
						},
					}
				}

				if (attemptNumber === maxAttempts) {
					const reason = buildValidationFailureReason(validation, attempts.length)

					return {
						outcome: {
							status: 'VALIDATION_FAILED',
							attempts: attempts.length,
							touchedFiles: [...touchedFiles],
							reason,
						},
						trace: {
							model: agentModel,
							durationMs: Date.now() - executionStartedAtMs,
							notes: attemptNotes,
							toolCallLog: attempts.flatMap(entry => entry.trace.toolCallLog),
							events: attempts.flatMap(entry => entry.trace.events),
							attempts,
						},
					}
				}
			} catch (error) {
				const errorMessage = toErrorMessage(error)
				const attemptDurationMs = Math.max(1, Date.now() - attemptStartedAtMs)
				const attempt: ExecutePortAttemptResult = {
					attempt: attemptNumber,
					status: 'PROVIDER_ERROR',
					touchedFiles: [],
					validation: [],
					trace: {
						notes: `Agent provider error: ${errorMessage}`,
						durationMs: attemptDurationMs,
						toolCallLog: [],
						events: [],
					},
				}

				attempts.push(attempt)

				logger.info(
					formatPortBotExecuteAttemptLine({
						runId: options.context.runId,
						attempt: attemptNumber,
						maxAttempts,
						touched: 0,
						validation: 'error',
						durationMs: attemptDurationMs,
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
					outcome: {
						status: 'PROVIDER_ERROR',
						attempts: attempts.length,
						touchedFiles: [...touchedFiles],
						reason: `Agent provider failed on attempt ${String(attemptNumber)}: ${errorMessage}`,
					},
					trace: {
						model: agentModel,
						durationMs: Date.now() - executionStartedAtMs,
						notes: attempt.trace.notes,
						toolCallLog: attempts.flatMap(entry => entry.trace.toolCallLog),
						events: attempts.flatMap(entry => entry.trace.events),
						attempts,
					},
				}
			}
		} finally {
			logger.groupEnd()
		}
	}

	return {
		outcome: {
			status: 'PROVIDER_ERROR',
			attempts: attempts.length,
			touchedFiles: [...touchedFiles],
			reason: `Execution stopped before completing after ${String(attempts.length)} attempts.`,
		},
		trace: {
			model: agentModel,
			durationMs: Date.now() - executionStartedAtMs,
			notes: attempts.at(-1)?.trace.notes,
			toolCallLog: attempts.flatMap(entry => entry.trace.toolCallLog),
			events: attempts.flatMap(entry => entry.trace.events),
			attempts,
		},
	}
}
