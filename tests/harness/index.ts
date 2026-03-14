/**
 * Scenario test harness — barrel export.
 *
 * Provides real git operations against local temp repos, an in-memory GitHub
 * writer that tracks all mutations, and a scripted agent provider. No network,
 * no LLM, no live repos.
 */
export { createCrashingAgent, createScriptedAgent } from './agent.ts'
export {
	makeAutoPortChange,
	makeConfigOnlyChange,
	makeDocsOnlyChange,
	makeNoPortChange,
	makeSourceChange,
} from './fixtures.ts'
export { extractDetailsBlock, extractSection, parsePrBody } from './pr-body.ts'
export { createLocalReader } from './reader.ts'
export { cleanupTempDirs, createRepos } from './repos.ts'
export { fileExists, listBranches, listTargetDir, readTargetFile, runScenario } from './run.ts'
export { failingValidation, passingValidation } from './validation.ts'
export { createTrackingWriter } from './writer.ts'

export type { RunScenarioOptions } from './run.ts'
export type { GitHubState, ParsedPrBody, RepoSetup } from './types.ts'
