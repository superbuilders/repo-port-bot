import * as core from '@actions/core'

import { runAction } from './run-action.ts'

/**
 * Action entrypoint that runs the pipeline and publishes outputs.
 */
async function main(): Promise<void> {
	try {
		const result = await runAction()

		core.setOutput('run-id', result.runId)
		core.setOutput('outcome', result.outcome)
		core.setOutput('pr-url', result.targetPullRequestUrl ?? '')
		core.setOutput('issue-url', result.followUpIssueUrl ?? '')
		core.setOutput('summary', result.summary)
		core.summary.addHeading('repo-port-bot result')
		core.summary.addCodeBlock(
			JSON.stringify(
				{
					runId: result.runId,
					outcome: result.outcome,
					prUrl: result.targetPullRequestUrl ?? null,
					issueUrl: result.followUpIssueUrl ?? null,
					summary: result.summary,
				},
				null,
				2,
			),
			'json',
		)
		await core.summary.write()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		core.setFailed(message)
	}
}

void main()

export { runAction } from './run-action.ts'
