export type RunStepOptions = Readonly<{
  replace?: boolean;
}>;

export type TaskStatus = "pending" | "running" | "success" | "error";
