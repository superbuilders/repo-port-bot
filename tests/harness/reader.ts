/**
 * In-memory GitHub reader returning canned source change data.
 */
import type {
	ChangedFile,
	GitHubReader,
	PullRequestRef,
	SourceChange,
} from '../../packages/engine/src/index.ts'

/**
 * Create an in-memory reader returning canned source change data.
 *
 * @param change - Source change fixture.
 * @returns In-memory reader.
 */
export function createLocalReader(change: SourceChange): GitHubReader {
	return {
		async listPullRequestsForCommit(): Promise<PullRequestRef[]> {
			return change.pullRequest ? [change.pullRequest] : []
		},
		async listChangedFiles(): Promise<ChangedFile[]> {
			return change.files
		},
		async getFileContent(): Promise<string | undefined> {
			return undefined
		},
	}
}
