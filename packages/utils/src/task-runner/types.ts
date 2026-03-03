export type BaseTaskDef = Readonly<{
	allowFailure?: boolean
	id: string
	name?: string
	timeoutMs?: number
}>

export type TaskDef = BaseTaskDef &
	Readonly<{
		command: string
	}>

export type TaskStep = TaskDef | readonly TaskDef[]

export type TaskRunnerConfig = Readonly<{
	tasks: readonly TaskStep[]
}>

export type TaskResult = Readonly<{
	durationMs: number
	id: string
	ok: boolean
}>
