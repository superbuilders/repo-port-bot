import { joinNonEmptyLines, toErrorMessage } from '../utils.ts'
import { runValidationCommands } from './run-validation.ts'
import { buildValidationFailureReason } from './utils.ts'

import type { AgentProvider, ExecutionAttempt, ExecutionResult, PortContext } from '../types.ts'

interface ExecutePortOptions {
	agentProvider: AgentProvider
	context: PortContext
	maxAttempts?: number
	targetWorkingDirectory: string
	sourceWorkingDirectory?: string
	diffFilePath?: string
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

	if (maxAttempts < 1) {
		throw new Error('`maxAttempts` must be greater than or equal to 1.')
	}

	const history: ExecutionAttempt[] = []
	const touchedFiles = new Set<string>()

	for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
		try {
			const agentOutput = await options.agentProvider.executePort({
				files: options.context.sourceChange.files,
				targetWorkingDirectory: options.targetWorkingDirectory,
				sourceWorkingDirectory: options.sourceWorkingDirectory,
				diffFilePath: options.diffFilePath,
				pluginConfig: options.context.pluginConfig,
				previousAttempts: history,
			})

			for (const path of agentOutput.touchedFiles) {
				touchedFiles.add(path)
			}

			const validation = await runValidationCommands({
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

			if (allValidationPassed) {
				return {
					success: true,
					attempts: history.length,
					history,
					touchedFiles: [...touchedFiles],
				}
			}

			if (attemptNumber === maxAttempts) {
				return {
					success: false,
					attempts: history.length,
					history,
					touchedFiles: [...touchedFiles],
					failureReason: buildValidationFailureReason(validation, history.length),
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

			return {
				success: false,
				attempts: history.length,
				history,
				touchedFiles: [...touchedFiles],
				failureReason: `Agent provider failed on attempt ${String(attemptNumber)}: ${errorMessage}`,
			}
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
