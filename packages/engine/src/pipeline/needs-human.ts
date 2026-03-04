import { renderRunSummary } from '../github/render-body.ts'
import { getDurationMs } from '../utils.ts'
import { logOutcome, logStage } from './logging.ts'
import { postSourcePrCommentBestEffort } from './notify-source.ts'

import type { Octokit } from '@octokit/rest'
import type { Logger } from '@repo-port-bot/logger'

import type { commentOnSourcePr, deliverResult } from '../github/deliver.ts'
import type { PortContext, PortDecision, PortRunResult } from '../types.ts'

interface NeedsHumanFlowInput {
	octokit: Octokit
	context: PortContext
	decision: PortDecision
	targetWorkingDirectory: string
	deliverStage: typeof deliverResult
	commentStage: typeof commentOnSourcePr
	logger: Logger
	runId: string
	startedAtMs: number
	stageTimings: NonNullable<PortRunResult['stageTimings']>
}

/**
 * Execute the NEEDS_HUMAN branch: deliver follow-up issue, notify source PR, return result.
 *
 * @param input - Flow input.
 * @returns Needs-human run result.
 */
export async function runNeedsHumanFlow(input: NeedsHumanFlowInput): Promise<PortRunResult> {
	const deliverStartedAtMs = Date.now()
	const delivery = await input.deliverStage({
		octokit: input.octokit,
		context: input.context,
		decision: input.decision,
		targetWorkingDirectory: input.targetWorkingDirectory,
	})

	logStage(input.logger, input.runId, 'deliver', {
		outcome: delivery.outcome,
		deliverMs: (input.stageTimings.deliverMs = getDurationMs(deliverStartedAtMs)),
	})

	const notifyMs = await postSourcePrCommentBestEffort({
		commentStage: input.commentStage,
		context: input.context,
		octokit: input.octokit,
		outcome: 'needs_human',
		followUpIssueUrl: delivery.followUpIssueUrl,
		runId: input.runId,
		logger: input.logger,
	})

	if (notifyMs !== undefined) {
		logStage(input.logger, input.runId, 'notify', {
			outcome: 'needs_human',
			notifyMs: (input.stageTimings.notifyMs = notifyMs),
		})
	}

	logOutcome(input.logger, input.runId, 'needs_human', getDurationMs(input.startedAtMs))

	return {
		runId: input.runId,
		outcome: 'needs_human',
		decision: input.decision,
		followUpIssueUrl: delivery.followUpIssueUrl,
		summary: renderRunSummary({
			outcome: 'needs_human',
			decision: input.decision,
			followUpIssueUrl: delivery.followUpIssueUrl,
		}),
		durationMs: getDurationMs(input.startedAtMs),
		stageTimings: input.stageTimings,
	}
}
