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

  const commandRows = [...commandMap.entries()].map(([id, command]) => {
    const stdoutText = (stdoutByCommand.get(id) ?? []).join("");
    const stderrText = (stderrByCommand.get(id) ?? []).join("");
    const cmd = `${command.command} ${command.args.join(" ")}`.trim();

    const exitCode = command.code;
    const isSuccess = exitCode === 0;
    const statusClass = exitCode === null ? "status-running" : isSuccess ? "status-success" : "status-error";
    const exitText = exitCode === null ? "Running" : `Exit Code: ${exitCode}`;

    const stdoutBlock = stdoutText ? `<details><summary>stdout</summary><pre>${escapeHtml(stdoutText)}</pre></details>` : '';
    const stderrBlock = stderrText ? `<details><summary>stderr</summary><pre>${escapeHtml(stderrText)}</pre></details>` : '';

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
          ${!stdoutText && !stderrText ? '<div class="no-output">No output</div>' : ''}
        </div>
      </div>
    `;
  });

  const finalResult = [...records].reverse().find((record) => record.kind === "result");
  const status =
    finalResult && typeof finalResult.payload === "object" && finalResult.payload
      ? String((finalResult.payload as Record<string, unknown>).status ?? "unknown")
      : "unknown";

  const statusBadgeColor = status === "success" ? "success" : status === "failed" ? "failure" : "unknown";
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
        --text-muted: #cbd5e1;
        --card-bg: #1e293b;
        --border: #334155;
        --pre-bg: #0f172a;
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
      margin-bottom: 40px;
    }

    h1 {
      font-size: 2.5rem;
      font-weight: 700;
      margin: 0 0 16px 0;
      letter-spacing: -0.025em;
    }

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

    .status-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 0.875rem;
      font-weight: 600;
      text-transform: capitalize;
    }
    .status-badge.success { background-color: var(--success-bg); color: var(--success-text); }
    .status-badge.failure { background-color: var(--error-bg); color: var(--error-text); }
    .status-badge.unknown { background-color: var(--running-bg); color: var(--running-text); }

    h2 {
      font-size: 1.5rem;
      font-weight: 600;
      margin: 32px 0 16px 0;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
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
      transition: all 0.2s ease;
    }

    .card:hover {
      box-shadow: 0 4px 6px rgba(0,0,0,0.05);
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

    .card-body {
      padding: 0;
    }

    .cmd-source {
      padding: 8px 16px;
      color: var(--text-muted);
      font-size: 0.8rem;
      border-bottom: 1px solid var(--border);
    }

    details {
      border-bottom: 1px solid var(--border);
    }
    
    details:last-child {
      border-bottom: none;
    }

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
    
    summary:hover {
      background: rgba(0,0,0,0.02);
      color: var(--text);
    }

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
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
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
      <h1>Project Report</h1>
      <div class="meta-grid">
        <div class="meta-card">
          <div class="meta-label">Project Name</div>
          <div class="meta-value">${escapeHtml(meta.projectName)}</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Created At</div>
          <div class="meta-value">${escapeHtml(meta.timestamp)}</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Final Status</div>
          <div class="meta-value">
            <span class="status-badge ${statusBadgeColor}">
              ${escapeHtml(status)}
            </span>
          </div>
        </div>
      </div>
    </header>

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

    ${verifySummaries.length > 0 ? `
    <h2>Verify Results</h2>
    <ul class="verify-list">
      ${verifySummaries.map((summary) => `<li class="verify-item"><pre>${escapeHtml(summary)}</pre></li>`).join("\n")}
    </ul>
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
</body>
</html>`;

  await fs.writeFile(reportPath, html, "utf8");
  return reportPath;
}
