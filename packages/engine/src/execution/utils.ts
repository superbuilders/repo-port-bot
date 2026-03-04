import type { ValidationCommandResult } from '../types.ts'

/**
 * Build a failure reason from validation command output.
 *
 * @param validation - Validation result list from one attempt.
 * @param attempts - Number of attempts that were executed.
 * @returns Failure reason for final execution result.
 */
export function buildValidationFailureReason(
	validation: ValidationCommandResult[],
	attempts: number,
): string {
	const failed = validation.find(result => !result.ok)

	if (!failed) {
		return `Validation failed after ${String(attempts)} attempts.`
	}

	const exitCodeSuffix =
		failed.exitCode === undefined ? '' : ` (exit code ${String(failed.exitCode)})`

	return `Validation failed after ${String(attempts)} attempts: \`${failed.command}\`${exitCodeSuffix}.`
}
