export type EventSource = "pm" | "codex_exec" | "verify" | "shell";

export type EventRecord = {
  ts: string;
  source: EventSource;
  kind: string;
  payload: unknown;
};

export type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
};

export type VerifyOutcome = {
  passed: boolean;
  command: string;
  code: number | null;
  skipped: boolean;
  reason?: string;
};

export type StepType = "codex" | "shell" | "verify" | "report" | "repeat";

export type BaseStep = {
  id: string;
  type: StepType;
  if?: string;
  retries?: number;
  continue_on_error?: boolean;
  timeout_sec?: number;
  record?: boolean;
};

export type Step = BaseStep & {
  command?: string;
  cwd?: string;
  prompt?: string;
  prompt_file?: string;
  max_rounds?: number;
  until?: string;
  steps?: Step[];
};

export type Workflow = {
  vars?: Record<string, unknown>;
  steps: Step[];
};

export type StepResult = {
  success: boolean;
  exitCode: number | null;
  detail?: string;
};

export type WorkflowContext = {
  projectName: string;
  idea: string;
  projectDir: string;
  pmDir: string;
  runJsonlPath: string;
  sessionLogPath: string;
  vars: Record<string, string>;
  round: number;
  lastExitCode: number | null;
  verify: VerifyOutcome;
};
