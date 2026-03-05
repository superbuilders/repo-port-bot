import type { Octokit } from '@octokit/rest'

import type {
	ChangedFile,
	ChangedFileStatus,
	CreatedIssue,
	CreatedPullRequest,
	GitHubReader,
	GitHubWriter,
} from '../types.ts'

/**
 * Normalize GitHub file statuses into the engine status enum.
 *
 * @param status - Raw file status from GitHub pull files API.
 * @returns Normalized status used by engine types.
 */
function mapGithubFileStatus(status: string): ChangedFileStatus {
	switch (status) {
		case 'added': {
			return 'added'
		}
		case 'modified':
		case 'changed': {
			return 'modified'
		}
		case 'removed': {
			return 'deleted'
		}
		case 'renamed': {
			return 'renamed'
		}
		case 'copied': {
			return 'added'
		}
		default: {
			return 'modified'
		}
	}
}

/**
 * Create a `GitHubReader` backed by an Octokit instance.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns GitHubReader implementation.
 */
export function createOctokitReader(octokit: Octokit): GitHubReader {
	return {
		async listPullRequestsForCommit(owner, repo, commitSha) {
			const response = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
				owner,
				repo,
				commit_sha: commitSha,
			})

			return response.data.map(pr => ({
				number: pr.number,
				title: pr.title,
				body: pr.body ?? '',
				url: pr.html_url,
				labels: pr.labels
					.map(label => (typeof label === 'string' ? label : (label.name ?? '')))
					.filter(label => label.length > 0),
			}))
		},

		async listChangedFiles(owner, repo, pullRequestNumber) {
			const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
				owner,
				repo,
				pull_number: pullRequestNumber,
				per_page: 100,
			})

			return files.map(
				(file): ChangedFile => ({
					path: file.filename,
					status: mapGithubFileStatus(file.status),
					additions: file.additions,
					deletions: file.deletions,
					patch: file.patch,
					previousPath: file.previous_filename ?? undefined,
				}),
			)
		},

		async getFileContent(owner, repo, path, ref) {
			const NOT_FOUND = 404

			try {
				const response = await octokit.rest.repos.getContent({ owner, repo, path, ref })
				const payload = response.data

				if (Array.isArray(payload) || payload.type !== 'file' || !payload.content) {
					return undefined
				}

				return Buffer.from(payload.content, 'base64').toString('utf8')
			} catch (error) {
				if (
					error &&
					typeof error === 'object' &&
					(error as { status?: unknown }).status === NOT_FOUND
				) {
					return undefined
				}

				throw error
			}
		},
	}
}

/**
 * Create a `GitHubWriter` backed by an Octokit instance.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns GitHubWriter implementation.
 */
export function createOctokitWriter(octokit: Octokit): GitHubWriter {
	return {
		async createPullRequest(params): Promise<CreatedPullRequest> {
			const response = await octokit.rest.pulls.create({
				owner: params.owner,
				repo: params.repo,
				title: params.title,
				body: params.body,
				head: params.head,
				base: params.base,
				draft: params.draft,
			})

			return { number: response.data.number, url: response.data.html_url }
		},

		async createIssue(params): Promise<CreatedIssue> {
			const response = await octokit.rest.issues.create({
				owner: params.owner,
				repo: params.repo,
				title: params.title,
				body: params.body,
				labels: params.labels,
			})

			return { number: response.data.number, url: response.data.html_url }
		},

		async addLabels(params): Promise<void> {
			await octokit.rest.issues.addLabels({
				owner: params.owner,
				repo: params.repo,
				issue_number: params.issueNumber,
				labels: params.labels,
			})
		},

		async createComment(params): Promise<string | undefined> {
			const response = await octokit.rest.issues.createComment({
				owner: params.owner,
				repo: params.repo,
				issue_number: params.issueNumber,
				body: params.body,
			})

			return response.data.html_url
		},
		async listComments(params) {
			const comments = await octokit.paginate(octokit.rest.issues.listComments, {
				owner: params.owner,
				repo: params.repo,
				issue_number: params.issueNumber,
				per_page: 100,
			})

			return comments.map(comment => ({
				url: comment.html_url,
				body: comment.body ?? '',
				createdAt: comment.created_at,
				authorLogin: comment.user?.login,
			}))
		},
		async findPullRequestForBranch(params) {
			const response = await octokit.rest.pulls.list({
				owner: params.owner,
				repo: params.repo,
				head: `${params.owner}:${params.head}`,
				base: params.base,
				state: 'open',
				per_page: 1,
			})
			const match = response.data[0]

			if (!match) {
				return undefined
			}

			return { number: match.number, url: match.html_url }
		},
		async updatePullRequest(params) {
			await octokit.rest.pulls.update({
				owner: params.owner,
				repo: params.repo,
				pull_number: params.pullNumber,
				title: params.title,
				body: params.body,
			})
		},
	}
}
