import type { Octokit } from '@octokit/rest'

import type { ChangedFile, ChangedFileStatus, PullRequestRef, SourceChange } from '../types.ts'

interface ReadSourceContextOptions {
	octokit: Octokit
	owner: string
	repo: string
	commitSha: string
}

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
 * Convert GitHub pull request payload into `PullRequestRef`.
 *
 * @param pullRequest - Pull request payload returned by GitHub API.
 * @returns Normalized pull request reference.
 */
function toPullRequestRef(
	pullRequest: Awaited<
		ReturnType<Octokit['rest']['repos']['listPullRequestsAssociatedWithCommit']>
	>['data'][number],
): PullRequestRef {
	return {
		number: pullRequest.number,
		title: pullRequest.title,
		body: pullRequest.body ?? '',
		url: pullRequest.html_url,
		labels: pullRequest.labels
			.map(label => (typeof label === 'string' ? label : (label.name ?? '')))
			.filter(label => label.length > 0),
	}
}

/**
 * Convert GitHub file payload into `ChangedFile`.
 *
 * @param file - File entry from GitHub pull files API.
 * @returns Normalized changed file record.
 */
function toChangedFile(
	file: Awaited<ReturnType<Octokit['rest']['pulls']['listFiles']>>['data'][number],
): ChangedFile {
	return {
		path: file.filename,
		status: mapGithubFileStatus(file.status),
		additions: file.additions,
		deletions: file.deletions,
		patch: file.patch,
		previousPath: file.previous_filename ?? undefined,
	}
}

/**
 * Read source context from GitHub APIs for a merge-triggered push event.
 *
 * @param options - Repository and commit lookup details.
 * @returns Normalized source change payload for the decision/execution pipeline.
 */
export async function readSourceContext(options: ReadSourceContextOptions): Promise<SourceChange> {
	const { commitSha, octokit, owner, repo } = options
	const associatedPullRequests = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
		owner,
		repo,
		commit_sha: commitSha,
	})

	const pullRequest = associatedPullRequests.data[0]

	if (!pullRequest) {
		return {
			mergedCommitSha: commitSha,
			pullRequest: undefined,
			files: [],
		}
	}

	const changedFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
		owner,
		repo,
		pull_number: pullRequest.number,
		per_page: 100,
	})

	return {
		mergedCommitSha: commitSha,
		pullRequest: toPullRequestRef(pullRequest),
		files: changedFiles.map(toChangedFile),
	}
}
