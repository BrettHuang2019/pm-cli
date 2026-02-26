import { promises as fs } from "fs";
import path from "path";
import { escapeHtml } from "./logging";
import { EventRecord } from "./types";

function asObj(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function fmtJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

interface ParsedStderr {
  model: string;
  provider: string;
  thinkingSteps: Array<{ summary: string; decision: string }>;
  filesChanged: string[];
  tokens: number;
}

function parseStderr(chunks: string[]): ParsedStderr {
  let model = "";
  let provider = "";
  const steps: Array<{ summary: string; decision: string }> = [];
  const filesChangedSet = new Set<string>();
  let tokens = 0;
  let pendingThinking = "";

  for (const chunk of chunks) {
    if (chunk.startsWith("thinking\n")) {
      pendingThinking = chunk
        .slice("thinking\n".length)
        .replace(/\*\*/g, "")
        .trim();
    } else if (chunk.startsWith("codex\n")) {
      const decision = chunk.slice("codex\n".length).trim();
      if (pendingThinking) {
        steps.push({ summary: pendingThinking, decision });
        pendingThinking = "";
      }
    } else if (chunk.startsWith("file update\n")) {
      // "file update\nA /full/path" — actual file creation/modification
      const rest = chunk.slice("file update\n".length);
      const firstLine = rest.split("\n")[0].trim();
      const match = firstLine.match(/^([AMD])\s+(.+)/);
      if (match) {
        const op = match[1];
        const basename = match[2].trim().split("/").pop() ?? match[2].trim();
        filesChangedSet.add(`${op}\t${basename}`);
      }
    } else if (chunk.startsWith("tokens used\n")) {
      const countStr = chunk.slice("tokens used\n".length).split("\n")[0].replace(/,/g, "");
      tokens = parseInt(countStr, 10) || 0;
    } else {
      // Config header: model/provider lines
      for (const line of chunk.split("\n")) {
        if (line.startsWith("model: ")) model = line.slice("model: ".length).trim();
        else if (line.startsWith("provider: ")) provider = line.slice("provider: ".length).trim();
      }
    }
  }

  if (pendingThinking) {
    steps.push({ summary: pendingThinking, decision: "" });
  }

  return { model, provider, thinkingSteps: steps, filesChanged: [...filesChangedSet], tokens };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function truncateDecision(text: string): string {
  const firstPara = text.split("\n\n")[0].trim();
  if (firstPara.length <= 200) return firstPara;
  return firstPara.slice(0, 200) + "…";
}

export async function generateReport(projectDir: string): Promise<string> {
  const pmDir = path.join(projectDir, ".pm");
  const metaPath = path.join(pmDir, "meta.json");
  const runJsonlPath = path.join(pmDir, "run.jsonl");
  const reportPath = path.join(pmDir, "report.html");

  const metaRaw = await fs.readFile(metaPath, "utf8");
  const meta = JSON.parse(metaRaw) as { projectName: string; timestamp: string; pmVersion: string };
  const lines = (await fs.readFile(runJsonlPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const records = lines.map((line) => JSON.parse(line) as EventRecord);

  const commandMap = new Map<string, { command: string; args: string[]; code: number | null; source: string }>();
  const stdoutByCommand = new Map<string, string[]>();
  const stderrByCommand = new Map<string, string[]>();
  const verifySummaries: string[] = [];
  const workflowStepRows: string[] = [];

  for (const record of records) {
    const payload = asObj(record.payload);
    if (record.kind === "command_start" && payload) {
      const id = String(payload.commandId ?? "");
      commandMap.set(id, {
        command: String(payload.command ?? ""),
        args: Array.isArray(payload.args) ? payload.args.map(String) : [],
        code: null,
        source: record.source
      });
    } else if (record.kind === "command_end" && payload) {
      const id = String(payload.commandId ?? "");
      const existing = commandMap.get(id);
      if (existing) {
        existing.code = payload.code === null ? null : Number(payload.code);
        commandMap.set(id, existing);
      } else {
        commandMap.set(id, {
          command: "",
          args: [],
          code: payload.code === null ? null : Number(payload.code),
          source: record.source
        });
      }
    } else if (record.kind === "stdout" && payload) {
      const id = String(payload.commandId ?? "");
      const text = String(payload.text ?? "");
      stdoutByCommand.set(id, [...(stdoutByCommand.get(id) ?? []), text]);
    } else if (record.kind === "stderr" && payload) {
      const id = String(payload.commandId ?? "");
      const text = String(payload.text ?? "");
      stderrByCommand.set(id, [...(stderrByCommand.get(id) ?? []), text]);
    } else if ((record.kind === "verify_end" || record.kind === "verify_skip") && payload) {
      verifySummaries.push(fmtJson(payload));
    } else if (
      record.kind === "workflow_step_start" ||
      record.kind === "workflow_step_end" ||
      record.kind === "workflow_step_error" ||
      record.kind === "workflow_step_skip" ||
      record.kind === "workflow_round_start" ||
      record.kind === "workflow_round_end"
    ) {
      workflowStepRows.push(`
      <tr>
        <td>${escapeHtml(record.ts)}</td>
        <td>${escapeHtml(record.kind)}</td>
        <td>${escapeHtml(String(payload.stepId ?? "-"))}</td>
        <td><pre>${escapeHtml(fmtJson(payload))}</pre></td>
      </tr>
      `);
    }
  }

  // --- Executive summary data ---

  // Stdout summary from codex command
  let stdoutSummary = "";
  for (const [id, cmd] of commandMap.entries()) {
    if (cmd.command === "codex") {
      stdoutSummary = (stdoutByCommand.get(id) ?? []).join("").trim();
      break;
    }
  }

  // Parse stderr from all codex commands
  let allStderrChunks: string[] = [];
  for (const [id, cmd] of commandMap.entries()) {
    if (cmd.command === "codex") {
      allStderrChunks = [...allStderrChunks, ...(stderrByCommand.get(id) ?? [])];
    }
  }
  const parsed = parseStderr(allStderrChunks);

  // Duration
  const firstTs = records[0]?.ts;
  const lastTs = records[records.length - 1]?.ts;
  const durationMs =
    firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : 0;
  const duration = durationMs > 0 ? formatDuration(durationMs) : "—";

  // Status
  const finalResult = [...records].reverse().find((record) => record.kind === "result");
  const status =
    finalResult && typeof finalResult.payload === "object" && finalResult.payload
      ? String((finalResult.payload as Record<string, unknown>).status ?? "unknown")
      : "unknown";

  const statusBadgeColor = status === "success" ? "success" : status === "failed" ? "failure" : "unknown";
  const statusIcon = status === "success" ? "✓" : status === "failed" ? "✗" : "?";
  const statusLabel = status === "success" ? "Success" : status === "failed" ? "Failed" : "Unknown";

  const tokensFormatted = parsed.tokens > 0 ? parsed.tokens.toLocaleString("en-US") : "—";
  const modelDisplay = parsed.model || "—";

  // Files changed HTML
  const filesHtml = parsed.filesChanged.length > 0
    ? parsed.filesChanged.map((entry) => {
        const [op, name] = entry.split("\t");
        const opClass = op === "A" ? "op-add" : op === "D" ? "op-del" : "op-mod";
        const opLabel = op === "A" ? "A" : op === "D" ? "D" : "M";
        return `<div class="file-entry"><span class="file-op ${opClass}">${opLabel}</span><span class="file-name">${escapeHtml(name ?? "")}</span></div>`;
      }).join("\n")
    : `<div class="empty-state">No files modified</div>`;

  // Timeline HTML
  const timelineHtml = parsed.thinkingSteps.length > 0
    ? `<ol class="timeline">${parsed.thinkingSteps.map(({ summary, decision }) => {
        const preview = decision ? truncateDecision(decision) : "";
        return `<li class="timeline-item">
          <div class="timeline-content">
            <div class="timeline-thinking">${escapeHtml(summary)}</div>
            ${preview ? `<div class="timeline-decision">"${escapeHtml(preview)}"</div>` : ""}
          </div>
        </li>`;
      }).join("\n")}</ol>`
    : `<div class="empty-state">No AI decisions recorded</div>`;

  // Verification HTML
  const verifyHtml = verifySummaries.length > 0
    ? `<ul class="verify-list">${verifySummaries.map((s) => `<li class="verify-item"><pre>${escapeHtml(s)}</pre></li>`).join("\n")}</ul>`
    : `<div class="verify-skipped">Skipped (no test markers)</div>`;

  // Raw command cards
  const commandRows = [...commandMap.entries()].map(([id, command]) => {
    const stdoutText = (stdoutByCommand.get(id) ?? []).join("");
    const stderrText = (stderrByCommand.get(id) ?? []).join("");
    const cmd = `${command.command} ${command.args.join(" ")}`.trim();
    const exitCode = command.code;
    const isSuccess = exitCode === 0;
    const statusClass = exitCode === null ? "status-running" : isSuccess ? "status-success" : "status-error";
    const exitText = exitCode === null ? "Running" : `Exit Code: ${exitCode}`;
    const stdoutBlock = stdoutText
      ? `<details><summary>stdout</summary><pre>${escapeHtml(stdoutText)}</pre></details>`
      : "";
    const stderrBlock = stderrText
      ? `<details><summary>stderr</summary><pre>${escapeHtml(stderrText)}</pre></details>`
      : "";
    return `
      <div class="card command-card ${statusClass}">
        <div class="card-header">
          <div class="cmd-text">${escapeHtml(cmd || id)}</div>
          <div class="cmd-badge">${escapeHtml(exitText)}</div>
        </div>
        <div class="card-body">
          <div class="cmd-source">source: ${escapeHtml(command.source)}</div>
          ${stdoutBlock}
          ${stderrBlock}
          ${!stdoutText && !stderrText ? '<div class="no-output">No output</div>' : ""}
        </div>
      </div>
    `;
  });

  const rawRows = records
    .map(
      (record) => `
      <tr>
        <td>${escapeHtml(record.ts)}</td>
        <td>${escapeHtml(record.source)}</td>
        <td>${escapeHtml(record.kind)}</td>
        <td><pre>${escapeHtml(fmtJson(record.payload))}</pre></td>
      </tr>
    `
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PM Report - ${escapeHtml(meta.projectName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f8fafc;
      --text: #0f172a;
      --text-muted: #64748b;
      --card-bg: #ffffff;
      --border: #e2e8f0;
      --primary: #3b82f6;
      --success: #10b981;
      --success-bg: #d1fae5;
      --success-text: #065f46;
      --error: #ef4444;
      --error-bg: #fee2e2;
      --error-text: #991b1b;
      --running: #f59e0b;
      --running-bg: #fef3c7;
      --running-text: #92400e;
      --pre-bg: #1e293b;
      --pre-text: #f8fafc;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --text: #f8fafc;
        --text-muted: #94a3b8;
        --card-bg: #1e293b;
        --border: #334155;
        --pre-bg: #0a1628;
        --success-bg: #064e3b;
        --success-text: #6ee7b7;
        --error-bg: #7f1d1d;
        --error-text: #fca5a5;
        --running-bg: #78350f;
        --running-text: #fcd34d;
      }
    }

    body {
      font-family: 'Inter', sans-serif;
      margin: 0;
      padding: 0;
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }

    .container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 40px 20px;
    }

    header {
      margin-bottom: 24px;
    }

    h1 {
      font-size: 2rem;
      font-weight: 700;
      margin: 0 0 20px 0;
      letter-spacing: -0.025em;
    }

    h2 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 32px 0 12px 0;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    /* ── Executive summary stats grid ── */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 8px;
    }

    @media (max-width: 600px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }

    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    .stat-card.stat-success {
      background: var(--success-bg);
      border-color: var(--success);
    }

    .stat-card.stat-failure {
      background: var(--error-bg);
      border-color: var(--error);
    }

    .stat-card.stat-unknown {
      background: var(--running-bg);
      border-color: var(--running);
    }

    .stat-value {
      font-size: 1.375rem;
      font-weight: 700;
      margin-bottom: 2px;
      letter-spacing: -0.01em;
    }

    .stat-card.stat-success .stat-value { color: var(--success-text); }
    .stat-card.stat-failure .stat-value { color: var(--error-text); }
    .stat-card.stat-unknown .stat-value { color: var(--running-text); }

    .stat-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 600;
    }

    .stat-card.stat-success .stat-label { color: var(--success-text); opacity: 0.7; }
    .stat-card.stat-failure .stat-label { color: var(--error-text); opacity: 0.7; }
    .stat-card.stat-unknown .stat-label { color: var(--running-text); opacity: 0.7; }

    /* ── Summary block ── */
    .summary-block {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      font-size: 0.9rem;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      line-height: 1.6;
      overflow-x: auto;
    }

    /* ── Files changed ── */
    .files-list {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }

    .file-entry {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
    }

    .file-entry:last-child { border-bottom: none; }

    .file-op {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 700;
      flex-shrink: 0;
    }

    .op-add { background: var(--success-bg); color: var(--success-text); }
    .op-del { background: var(--error-bg); color: var(--error-text); }
    .op-mod { background: var(--running-bg); color: var(--running-text); }

    .file-name { color: var(--text); }

    /* ── AI Decision Timeline ── */
    .timeline {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      counter-reset: timeline;
    }

    .timeline-item {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      counter-increment: timeline;
      display: grid;
      grid-template-columns: 28px 1fr;
      gap: 8px;
      align-items: start;
    }

    .timeline-item:last-child { border-bottom: none; }

    .timeline-item::before {
      content: counter(timeline);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      background: var(--border);
      border-radius: 50%;
      font-size: 0.7rem;
      font-weight: 700;
      color: var(--text-muted);
      flex-shrink: 0;
      margin-top: 1px;
    }

    .timeline-content { display: flex; flex-direction: column; gap: 4px; }

    .timeline-thinking {
      font-weight: 600;
      font-size: 0.9rem;
    }

    .timeline-decision {
      font-size: 0.825rem;
      color: var(--text-muted);
      font-style: italic;
      line-height: 1.5;
    }

    /* ── Verification ── */
    .verify-skipped {
      color: var(--text-muted);
      font-size: 0.9rem;
      padding: 12px 0;
    }

    /* ── Empty state ── */
    .empty-state {
      color: var(--text-muted);
      font-size: 0.875rem;
      font-style: italic;
      padding: 12px 0;
    }

    /* ── Raw Details section ── */
    .raw-details-wrapper {
      margin-top: 40px;
      border-top: 2px dashed var(--border);
      padding-top: 8px;
    }

    .raw-details-wrapper > details > summary {
      padding: 12px 0;
      cursor: pointer;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-muted);
      user-select: none;
      list-style: none;
    }

    .raw-details-wrapper > details > summary:hover { color: var(--text); }
    .raw-details-wrapper > details > summary::marker,
    .raw-details-wrapper > details > summary::-webkit-details-marker { display: none; }

    .raw-details-inner {
      padding-top: 8px;
    }

    /* ── Existing raw section styles ── */
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }

    .meta-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }

    .meta-label {
      font-size: 0.875rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
      font-weight: 600;
    }

    .meta-value {
      font-size: 1.125rem;
      font-weight: 500;
    }

    .command-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    }

    .card-header {
      padding: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(0,0,0,0.02);
      border-bottom: 1px solid var(--border);
      gap: 16px;
    }

    .cmd-text {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9rem;
      font-weight: 600;
      word-break: break-all;
    }

    .cmd-badge {
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .status-success .cmd-badge { background: var(--success-bg); color: var(--success-text); }
    .status-error .cmd-badge { background: var(--error-bg); color: var(--error-text); }
    .status-running .cmd-badge { background: var(--running-bg); color: var(--running-text); }

    .status-success { border-left: 4px solid var(--success); }
    .status-error { border-left: 4px solid var(--error); }
    .status-running { border-left: 4px solid var(--running); }

    .card-body { padding: 0; }

    .cmd-source {
      padding: 8px 16px;
      color: var(--text-muted);
      font-size: 0.8rem;
      border-bottom: 1px solid var(--border);
    }

    details { border-bottom: 1px solid var(--border); }
    details:last-child { border-bottom: none; }

    summary {
      padding: 12px 16px;
      cursor: pointer;
      font-weight: 500;
      font-size: 0.875rem;
      color: var(--text-muted);
      user-select: none;
      display: flex;
      align-items: center;
    }

    summary:hover { background: rgba(0,0,0,0.02); color: var(--text); }

    pre {
      margin: 0;
      padding: 16px;
      background: var(--pre-bg);
      color: var(--pre-text);
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.875rem;
      line-height: 1.4;
    }

    .no-output {
      padding: 16px;
      color: var(--text-muted);
      font-size: 0.875rem;
      font-style: italic;
    }

    .verify-list {
      list-style: none;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .verify-item {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }

    .verify-item pre {
      margin: 0;
      padding: 10px 12px;
      background: var(--pre-bg);
      color: var(--pre-text);
      border-radius: 8px;
      font-size: 0.8rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--border);
      background: var(--card-bg);
      border-radius: 12px;
      overflow: hidden;
    }

    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
      font-size: 0.9rem;
    }

    th {
      background: rgba(0,0,0,0.02);
      font-weight: 600;
    }

    td pre {
      margin: 0;
      padding: 8px;
      font-size: 0.8rem;
      max-height: 220px;
      overflow: auto;
      border-radius: 8px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Project: ${escapeHtml(meta.projectName)}</h1>
      <div class="stats-grid">
        <div class="stat-card stat-${statusBadgeColor}">
          <div class="stat-value">${statusIcon} ${escapeHtml(statusLabel)}</div>
          <div class="stat-label">Status</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(duration)}</div>
          <div class="stat-label">Duration</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(modelDisplay)}</div>
          <div class="stat-label">Model</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${escapeHtml(tokensFormatted)}</div>
          <div class="stat-label">Tokens</div>
        </div>
      </div>
    </header>

    ${stdoutSummary ? `
    <h2>Summary</h2>
    <div class="summary-block">${escapeHtml(stdoutSummary)}</div>
    ` : ""}

    <h2>Files Changed</h2>
    <div class="files-list">
      ${filesHtml}
    </div>

    <h2>AI Decision Timeline</h2>
    ${timelineHtml}

    <h2>Verification</h2>
    ${verifyHtml}

    <div class="raw-details-wrapper">
      <details>
        <summary>▶ Raw Details</summary>
        <div class="raw-details-inner">
          <h2>Command Execution History</h2>
          <div class="command-list">
            ${commandRows.join("\n")}
          </div>

          ${workflowStepRows.length > 0 ? `
          <h2>Workflow Steps</h2>
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Kind</th>
                <th>Step</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              ${workflowStepRows.join("\n")}
            </tbody>
          </table>
          ` : ""}

          <h2>Raw Event Log</h2>
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Source</th>
                <th>Kind</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              ${rawRows}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  </div>
</body>
</html>`;

  await fs.writeFile(reportPath, html, "utf8");
  return reportPath;
}
