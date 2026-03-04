import type { GitHubReader, SourceChange } from '../types.ts'

interface ReadSourceContextOptions {
	reader: GitHubReader
	owner: string
	repo: string
	commitSha: string
}

/**
 * Read source context from GitHub APIs for a merge-triggered push event.
 *
 * @param options - Repository and commit lookup details.
 * @returns Normalized source change payload for the decision/execution pipeline.
 */
export async function readSourceContext(options: ReadSourceContextOptions): Promise<SourceChange> {
	const { commitSha, owner, reader, repo } = options
	const pullRequests = await reader.listPullRequestsForCommit(owner, repo, commitSha)
	const pullRequest = pullRequests[0]

	if (!pullRequest) {
		return {
			mergedCommitSha: commitSha,
			pullRequest: undefined,
			files: [],
		}
	}

	const files = await reader.listChangedFiles(owner, repo, pullRequest.number)

	return {
		mergedCommitSha: commitSha,
		pullRequest,
		files,
	}
}
