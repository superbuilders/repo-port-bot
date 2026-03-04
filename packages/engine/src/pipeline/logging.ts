import { formatPortBotLine, formatPortBotStageLine } from '@repo-port-bot/logger'

import type { Logger } from '@repo-port-bot/logger'

import type { PortRunResult } from '../types.ts'

/**
 * Emit a structured stage log line for one pipeline phase.
 *
 * Intended usage is inside a surrounding logger group (for example:
 * `Context: ...`, `Config: ...`, `Decision: ...`, `Deliver: ...`), so Actions
 * UI shows a collapsed section title with this structured detail inside.
 *
 * @param logger - Active logger.
 * @param runId - Correlation run ID.
 * @param stage - Pipeline stage.
 * @param fields - Additional fields.
 */
export function logStage(
	logger: Logger,
	runId: string,
	stage: 'context' | 'config' | 'decision' | 'execute' | 'deliver' | 'notify',
	fields: Record<string, number | string | undefined>,
): void {
	logger.info(formatPortBotStageLine({ runId, stage, fields }))
}

/**
 * Emit a structured final outcome log line.
 *
 * This line should remain outside stage groups so operators can always see the
 * final result without expanding any sections in the Actions log viewer.
 *
 * @param logger - Active logger.
 * @param runId - Correlation run ID.
 * @param outcome - Final outcome.
 * @param durationMs - Run duration.
 */
export function logOutcome(
	logger: Logger,
	runId: string,
	outcome: PortRunResult['outcome'],
	durationMs: number,
): void {
	logger.info(formatPortBotLine({ runId, fields: { stage: 'outcome', outcome, durationMs } }))
}

/**
 * Emit a structured failure outcome line at error level.
 *
 * Like `logOutcome`, keep this outside stage groups so failures are immediately
 * visible in flat log view and surfaced at error level.
 *
 * @param logger - Active logger.
 * @param runId - Correlation run ID.
 * @param durationMs - Run duration.
 * @param error - Failure message.
 */
export function logFailedOutcome(
	logger: Logger,
	runId: string,
	durationMs: number,
	error: string,
): void {
	logger.error(
		formatPortBotLine({
			runId,
			fields: { stage: 'outcome', outcome: 'failed', durationMs, error },
		}),
	)
}
