import { getDurationMs } from '../utils.ts'

import type { Octokit } from '@octokit/rest'
import type { Logger } from '@repo-port-bot/logger'

import type { commentOnSourcePr } from '../github/deliver.ts'
import type { PortContext, PortRunResult } from '../types.ts'

interface PostSourcePrCommentInput {
	commentStage: typeof commentOnSourcePr
	context: PortContext
	octokit: Octokit
	outcome: Exclude<PortRunResult['outcome'], 'skipped_not_required'>
	runId: string
	logger: Logger
	targetPullRequestUrl?: string
	followUpIssueUrl?: string
}

/**
 * Post a source PR comment as a best-effort side effect.
 *
 * @param input - Comment input.
 * @returns Notification duration in ms, or `undefined` if skipped/failed.
 */
export async function postSourcePrCommentBestEffort(
	input: PostSourcePrCommentInput,
): Promise<number | undefined> {
	const sourcePullRequestNumber = input.context.sourceChange.pullRequest?.number

	if (!sourcePullRequestNumber) {
		return undefined
	}

	const notifyStartedAtMs = Date.now()

	try {
		await input.commentStage({
			octokit: input.octokit,
			sourceRepo: input.context.sourceRepo,
			pullRequestNumber: sourcePullRequestNumber,
			context: input.context,
			outcome: input.outcome,
			targetPullRequestUrl: input.targetPullRequestUrl,
			followUpIssueUrl: input.followUpIssueUrl,
			runId: input.runId,
			logger: input.logger,
		})
	} catch (error) {
		input.logger.warn('[port-bot] Unable to post source PR comment from pipeline stage.', error)

		return undefined
	}

	return getDurationMs(notifyStartedAtMs)
}
