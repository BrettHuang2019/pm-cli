import { WorkflowContext } from "./types";

function getByPath(input: unknown, dotted: string): unknown {
  let cur: unknown = input;
  for (const seg of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null || !(seg in cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function parseCondToken(token: string, data: Record<string, unknown>): unknown {
  const t = token.trim();
  if ((t.startsWith("\"") && t.endsWith("\"")) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === "true") {
    return true;
  }
  if (t === "false") {
    return false;
  }
  if (t === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return Number(t);
  }
  return getByPath(data, t);
}

export function renderTemplate(s: string, data: Record<string, unknown>): string {
  return s.replace(/{{\s*([\w.]+)\s*}}/g, (_m, key: string) => {
    const v = getByPath(data, key);
    if (v === undefined || v === null) {
      return "";
    }
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

export function evalCond(expr: string, data: Record<string, unknown>): boolean {
  const s = renderTemplate(expr, data).trim();
  const eq = s.indexOf("==");
  if (eq >= 0) {
    return parseCondToken(s.slice(0, eq), data) === parseCondToken(s.slice(eq + 2), data);
  }
  const ne = s.indexOf("!=");
  if (ne >= 0) {
    return parseCondToken(s.slice(0, ne), data) !== parseCondToken(s.slice(ne + 2), data);
  }
  return Boolean(parseCondToken(s, data));
}

export function templateData(ctx: WorkflowContext): Record<string, unknown> {
  return {
    ...ctx.vars,
    slug: ctx.projectName,
    project: ctx.projectName,
    idea: ctx.idea,
    project_dir: ctx.projectDir,
    round: ctx.round,
    last_exit_code: ctx.lastExitCode,
    verify: ctx.verify
  };
}
