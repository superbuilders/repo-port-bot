/**
 * In-memory GitHub writer that tracks all mutations for assertions.
 */
import type {
	CreatedIssue,
	CreatedPullRequest,
	GitHubWriter,
} from '../../packages/engine/src/index.ts'
import type { GitHubState } from './types.ts'

const FIRST_PR_NUMBER = 100
const FIRST_ISSUE_NUMBER = 200

/**
 * Create a writer that records all mutations in memory.
 *
 * @returns Writer and its observable state.
 */
export function createTrackingWriter(): { writer: GitHubWriter; state: GitHubState } {
	const state: GitHubState = {
		pullRequests: [],
		issues: [],
		labels: [],
		comments: [],
	}

	let nextPrNumber = FIRST_PR_NUMBER
	let nextIssueNumber = FIRST_ISSUE_NUMBER

	const writer: GitHubWriter = {
		async createPullRequest(params) {
			state.pullRequests.push({
				title: params.title,
				body: params.body,
				head: params.head,
				base: params.base,
				draft: params.draft,
				labels: [],
			})

			const number = nextPrNumber++

			return {
				number,
				url: `https://github.com/${params.owner}/${params.repo}/pull/${String(number)}`,
			} satisfies CreatedPullRequest
		},
		async createIssue(params) {
			state.issues.push({
				title: params.title,
				body: params.body,
				labels: params.labels,
			})

			const number = nextIssueNumber++

			return {
				number,
				url: `https://github.com/${params.owner}/${params.repo}/issues/${String(number)}`,
			} satisfies CreatedIssue
		},
		async addLabels(params) {
			state.labels.push({ issueNumber: params.issueNumber, labels: params.labels })

			const pr = state.pullRequests.find(
				(_p, index) => index + FIRST_PR_NUMBER === params.issueNumber,
			)

			if (pr) {
				pr.labels.push(...params.labels)
			}
		},
		async createComment(params) {
			state.comments.push({ issueNumber: params.issueNumber, body: params.body })

			return `https://github.com/${params.owner}/${params.repo}/issues/${String(params.issueNumber)}#comment-1`
		},
		async removeLabel() {},
	}

	return { writer, state }
}
