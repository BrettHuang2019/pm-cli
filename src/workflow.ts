import { existsSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { parse as parseYaml } from "yaml";
import { appendJsonl, nowIso } from "./logging";
import { generateReport } from "./report";
import { getCodexInvocation, runCommandWithLogging } from "./runner";
import { evalCond, renderTemplate, templateData } from "./template";
import { runVerify } from "./verify";
import { Step, StepResult, Workflow, WorkflowContext } from "./types";

export const BUILTIN_WORKFLOW: Workflow = {
  steps: [
    {
      id: "gen",
      type: "codex",
      prompt: [
        "You are building a prototype from the idea below.",
        "",
        "Requirements:",
        "- prototype only",
        "- log everything",
        "- work in current folder",
        "- never create or modify files under .pm/",
        "",
        "Idea:",
        "{{idea}}"
      ].join("\n")
    },
    { id: "verify", type: "verify" },
    { id: "report", type: "report" }
  ]
};

function normalizeWorkflow(raw: unknown): Workflow {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Workflow file must parse to an object.");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.steps)) {
    throw new Error("Workflow must contain 'steps' array.");
  }
  return {
    vars: typeof obj.vars === "object" && obj.vars !== null ? (obj.vars as Record<string, unknown>) : {},
    steps: obj.steps as Step[]
  };
}

function resolveWorkflowPath(rootDir: string, projectDir: string, explicit?: string): string | null {
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(rootDir, explicit);
  }
  const projectOverride = path.join(projectDir, "pm.workflow.yaml");
  if (existsSync(projectOverride)) {
    return projectOverride;
  }
  const globalDefault = path.join(os.homedir(), ".config", "pm", "workflows", "default.yaml");
  if (existsSync(globalDefault)) {
    return globalDefault;
  }
  return null;
}

export async function loadWorkflow(
  rootDir: string,
  projectDir: string,
  explicit?: string
): Promise<{ workflow: Workflow; source: string }> {
  const workflowPath = resolveWorkflowPath(rootDir, projectDir, explicit);
  if (!workflowPath) {
    return { workflow: BUILTIN_WORKFLOW, source: "builtin" };
  }
  const raw = await fs.readFile(workflowPath, "utf8");
  return { workflow: normalizeWorkflow(parseYaml(raw)), source: workflowPath };
}

async function execSingleStep(step: Step, ctx: WorkflowContext): Promise<StepResult> {
  const data = templateData(ctx);

  if (step.type === "codex") {
    let prompt = "";
    if (step.prompt) {
      prompt = renderTemplate(step.prompt, data);
    } else if (step.prompt_file) {
      const promptFilePath = path.isAbsolute(step.prompt_file)
        ? step.prompt_file
        : path.join(ctx.projectDir, step.prompt_file);
      prompt = renderTemplate(await fs.readFile(promptFilePath, "utf8"), data);
    } else {
      throw new Error(`codex step '${step.id}' requires prompt or prompt_file`);
    }

    await fs.writeFile(path.join(ctx.pmDir, "prompt.txt"), `${prompt}\n`, "utf8");
    await appendJsonl(ctx.runJsonlPath, {
      ts: nowIso(),
      source: "pm",
      kind: "file_write",
      payload: { path: ".pm/prompt.txt", stepId: step.id }
    });

    const inv = getCodexInvocation(prompt);
    const result = await runCommandWithLogging({
      runJsonlPath: ctx.runJsonlPath,
      sessionLogPath: ctx.sessionLogPath,
      source: "codex_exec",
      cwd: ctx.projectDir,
      command: inv.command,
      args: inv.args,
      commandId: `codex-${step.id}-${Date.now()}`,
      timeoutMs: step.timeout_sec ? step.timeout_sec * 1000 : undefined
    });
    ctx.lastExitCode = result.code;
    return { success: result.code === 0, exitCode: result.code };
  }

  if (step.type === "shell") {
    if (!step.command) {
      throw new Error(`shell step '${step.id}' requires command`);
    }
    const command = renderTemplate(step.command, data);
    const cwd = step.cwd ? renderTemplate(step.cwd, data) : ctx.projectDir;
    const result = await runCommandWithLogging({
      runJsonlPath: ctx.runJsonlPath,
      sessionLogPath: ctx.sessionLogPath,
      source: "shell",
      cwd,
      command,
      args: [],
      commandId: `shell-${step.id}-${Date.now()}`,
      timeoutMs: step.timeout_sec ? step.timeout_sec * 1000 : undefined,
      useShell: true
    });
    ctx.lastExitCode = result.code;
    return { success: result.code === 0, exitCode: result.code };
  }

  if (step.type === "verify") {
    const outcome = await runVerify(ctx.projectDir, ctx.runJsonlPath, ctx.sessionLogPath);
    ctx.verify = outcome;
    ctx.lastExitCode = outcome.code;
    return { success: outcome.passed || outcome.skipped, exitCode: outcome.code, detail: outcome.reason };
  }

  if (step.type === "report") {
    const reportPath = await generateReport(ctx.projectDir);
    await appendJsonl(ctx.runJsonlPath, {
      ts: nowIso(),
      source: "pm",
      kind: "report",
      payload: { stepId: step.id, reportPath }
    });
    return { success: true, exitCode: 0 };
  }

  return { success: false, exitCode: 1, detail: `unsupported step type: ${step.type}` };
}

async function execStep(step: Step, ctx: WorkflowContext): Promise<StepResult> {
  const record = step.record !== false;
  if (step.if && !evalCond(step.if, templateData(ctx))) {
    const skipped = { success: true, exitCode: ctx.lastExitCode, detail: "skipped by if" };
    if (record) {
      await appendJsonl(ctx.runJsonlPath, {
        ts: nowIso(),
        source: "pm",
        kind: "workflow_step_skip",
        payload: { stepId: step.id, if: step.if }
      });
    }
    return skipped;
  }

  if (step.type === "repeat") {
    const rounds = Number(step.max_rounds ?? 1);
    if (!Number.isFinite(rounds) || rounds <= 0) {
      throw new Error(`repeat step '${step.id}' requires max_rounds > 0`);
    }

    let last: StepResult = { success: true, exitCode: ctx.lastExitCode };
    let untilMet = false;
    for (let i = 1; i <= rounds; i += 1) {
      ctx.round = i;
      if (record) {
        await appendJsonl(ctx.runJsonlPath, {
          ts: nowIso(),
          source: "pm",
          kind: "workflow_round_start",
          payload: { stepId: step.id, round: i }
        });
      }
      for (const sub of step.steps ?? []) {
        last = await execStep(sub, ctx);
        if (!last.success && !sub.continue_on_error) {
          break;
        }
      }
      if (record) {
        await appendJsonl(ctx.runJsonlPath, {
          ts: nowIso(),
          source: "pm",
          kind: "workflow_round_end",
          payload: { stepId: step.id, round: i, success: last.success, exitCode: last.exitCode }
        });
      }
      if (step.until && evalCond(step.until, templateData(ctx))) {
        untilMet = true;
        break;
      }
    }

    return {
      success: step.until ? untilMet : last.success,
      exitCode: ctx.lastExitCode,
      detail: step.until ? `until=${step.until}` : undefined
    };
  }

  const retries = Math.max(0, Number(step.retries ?? 0));
  let last: StepResult = { success: false, exitCode: null };

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    if (record) {
      await appendJsonl(ctx.runJsonlPath, {
        ts: nowIso(),
        source: "pm",
        kind: "workflow_step_start",
        payload: { stepId: step.id, type: step.type, attempt }
      });
    }
    try {
      last = await execSingleStep(step, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      last = { success: false, exitCode: 1, detail: message };
      await appendJsonl(ctx.runJsonlPath, {
        ts: nowIso(),
        source: "pm",
        kind: "workflow_step_error",
        payload: { stepId: step.id, attempt, message }
      });
    }
    if (record) {
      await appendJsonl(ctx.runJsonlPath, {
        ts: nowIso(),
        source: "pm",
        kind: "workflow_step_end",
        payload: {
          stepId: step.id,
          type: step.type,
          attempt,
          success: last.success,
          exitCode: last.exitCode,
          detail: last.detail ?? null
        }
      });
    }
    if (last.success) {
      break;
    }
  }

  if (!last.success && step.continue_on_error) {
    return {
      success: true,
      exitCode: last.exitCode,
      detail: `continue_on_error=true; ${last.detail ?? "failed"}`
    };
  }
  return last;
}

export async function runWorkflow(workflow: Workflow, ctx: WorkflowContext): Promise<boolean> {
  for (const step of workflow.steps) {
    const result = await execStep(step, ctx);
    if (!result.success && !step.continue_on_error) {
      return false;
    }
  }
  return true;
}
