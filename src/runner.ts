import { createWriteStream, existsSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { appendJsonl, nowIso } from "./logging";
import { CommandResult, EventSource } from "./types";

export function platformCommand(command: string): string {
  if (process.platform === "win32" && command === "npm") {
    return "npm.cmd";
  }
  return command;
}

export function getCodexInvocation(prompt: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const codexJsPath = path.join(
      process.env.APPDATA ?? "",
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js"
    );
    if (existsSync(codexJsPath)) {
      return { command: process.execPath, args: [codexJsPath, "exec", "--yolo", prompt] };
    }
  }
  return { command: "codex", args: ["exec", "--yolo", prompt] };
}

export async function runCommandWithLogging(params: {
  runJsonlPath: string;
  sessionLogPath: string;
  source: EventSource;
  cwd: string;
  command: string;
  args: string[];
  commandId: string;
  timeoutMs?: number;
  useShell?: boolean;
}): Promise<CommandResult> {
  await appendJsonl(params.runJsonlPath, {
    ts: nowIso(),
    source: params.source,
    kind: "command_start",
    payload: { commandId: params.commandId, command: params.command, args: params.args, cwd: params.cwd }
  });

  const sessionStream = createWriteStream(params.sessionLogPath, { flags: "a" });
  sessionStream.write(`\n$ ${params.command} ${params.args.join(" ")}\n`);

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      shell: params.useShell ?? false
    });

    let settled = false;
    let timedOut = false;
    const timeoutHandle =
      params.timeoutMs && params.timeoutMs > 0
        ? setTimeout(async () => {
            timedOut = true;
            await appendJsonl(params.runJsonlPath, {
              ts: nowIso(),
              source: params.source,
              kind: "command_timeout",
              payload: { commandId: params.commandId, timeoutMs: params.timeoutMs }
            });
            child.kill();
          }, params.timeoutMs)
        : null;

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      sessionStream.end();
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      sessionStream.write(text);
      void appendJsonl(params.runJsonlPath, {
        ts: nowIso(),
        source: params.source,
        kind: "stdout",
        payload: { commandId: params.commandId, text }
      });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      sessionStream.write(text);
      void appendJsonl(params.runJsonlPath, {
        ts: nowIso(),
        source: params.source,
        kind: "stderr",
        payload: { commandId: params.commandId, text }
      });
    });

    child.on("error", async (error) => {
      await appendJsonl(params.runJsonlPath, {
        ts: nowIso(),
        source: params.source,
        kind: "command_error",
        payload: { commandId: params.commandId, message: error.message, name: error.name }
      });
      finish({ code: -1, signal: null, timedOut });
    });

    child.on("close", async (code, signal) => {
      await appendJsonl(params.runJsonlPath, {
        ts: nowIso(),
        source: params.source,
        kind: "command_end",
        payload: { commandId: params.commandId, code, signal, timedOut }
      });
      finish({ code, signal, timedOut });
    });
  });
}
