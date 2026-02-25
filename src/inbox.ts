import { existsSync, promises as fs } from "fs";
import path from "path";
import { appendJsonl, ensureDir, nowIso, writeJson } from "./logging";
import { renderTemplate, templateData } from "./template";
import { WorkflowContext } from "./types";
import { loadWorkflow, runWorkflow } from "./workflow";

async function getPmVersion(rootDir: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(rootDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export async function cmdInbox(params: {
  rootDir: string;
  projectName: string;
  idea: string;
  workflowPath?: string;
}): Promise<{ status: "success" | "failed"; projectDir: string; workflowSource: string }> {
  const projectDir = path.join(params.rootDir, "projects", params.projectName);
  if (existsSync(projectDir)) {
    throw new Error(`Project already exists: ${projectDir}`);
  }

  const pmDir = path.join(projectDir, ".pm");
  await ensureDir(pmDir);

  const ideaPath = path.join(pmDir, "idea.md");
  const promptPath = path.join(pmDir, "prompt.txt");
  const metaPath = path.join(pmDir, "meta.json");
  const runJsonlPath = path.join(pmDir, "run.jsonl");
  const sessionLogPath = path.join(pmDir, "session.log");

  await fs.writeFile(ideaPath, `${params.idea}\n`, "utf8");
  await writeJson(metaPath, {
    timestamp: nowIso(),
    pmVersion: await getPmVersion(params.rootDir),
    projectName: params.projectName
  });
  await fs.writeFile(promptPath, "", "utf8");
  await fs.writeFile(sessionLogPath, "", "utf8");

  await appendJsonl(runJsonlPath, {
    ts: nowIso(),
    source: "pm",
    kind: "lifecycle",
    payload: { step: "inbox_start", projectName: params.projectName, projectDir }
  });
  await appendJsonl(runJsonlPath, {
    ts: nowIso(),
    source: "pm",
    kind: "file_write",
    payload: { path: ".pm/idea.md" }
  });
  await appendJsonl(runJsonlPath, {
    ts: nowIso(),
    source: "pm",
    kind: "file_write",
    payload: { path: ".pm/meta.json" }
  });
  await appendJsonl(runJsonlPath, {
    ts: nowIso(),
    source: "pm",
    kind: "file_write",
    payload: { path: ".pm/prompt.txt" }
  });

  const loaded = await loadWorkflow(params.rootDir, projectDir, params.workflowPath);
  await appendJsonl(runJsonlPath, {
    ts: nowIso(),
    source: "pm",
    kind: "workflow_loaded",
    payload: { source: loaded.source, stepCount: loaded.workflow.steps.length }
  });

  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(loaded.workflow.vars ?? {})) {
    vars[k] = String(v ?? "");
  }

  const ctx: WorkflowContext = {
    projectName: params.projectName,
    idea: params.idea,
    projectDir,
    pmDir,
    runJsonlPath,
    sessionLogPath,
    vars,
    round: 0,
    lastExitCode: null,
    verify: { passed: false, command: "", code: null, skipped: true }
  };

  const seed = templateData(ctx);
  for (const [k, v] of Object.entries(ctx.vars)) {
    ctx.vars[k] = renderTemplate(v, seed);
  }

  const success = await runWorkflow(loaded.workflow, ctx);
  const status: "success" | "failed" = success ? "success" : "failed";

  await appendJsonl(runJsonlPath, {
    ts: nowIso(),
    source: "pm",
    kind: "result",
    payload: { status, codexExitCode: ctx.lastExitCode, reportHint: `pm report ${params.projectName}` }
  });

  return { status, projectDir, workflowSource: loaded.source };
}
