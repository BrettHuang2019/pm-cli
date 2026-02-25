import { existsSync, promises as fs } from "fs";
import path from "path";
import { appendJsonl, nowIso } from "./logging";
import { VerifyOutcome } from "./types";
import { platformCommand, runCommandWithLogging } from "./runner";

export async function runVerify(
  projectDir: string,
  runJsonlPath: string,
  sessionLogPath: string
): Promise<VerifyOutcome> {
  const packageJson = path.join(projectDir, "package.json");
  const pyproject = path.join(projectDir, "pyproject.toml");
  const requirements = path.join(projectDir, "requirements.txt");
  const setupPy = path.join(projectDir, "setup.py");

  await appendJsonl(runJsonlPath, {
    ts: nowIso(),
    source: "verify",
    kind: "verify_start",
    payload: { projectDir }
  });

  let verifyResultCode: number | null = null;
  let verifyCommand = "";
  let skippedReason: string | undefined;

  if (existsSync(packageJson)) {
    verifyCommand = "npm test";
    let result = await runCommandWithLogging({
      runJsonlPath,
      sessionLogPath,
      source: "verify",
      cwd: projectDir,
      command: platformCommand("npm"),
      args: ["test"],
      commandId: `verify-${Date.now()}-npm-test`
    });
    if (result.code !== 0) {
      verifyCommand = "npm run test";
      result = await runCommandWithLogging({
        runJsonlPath,
        sessionLogPath,
        source: "verify",
        cwd: projectDir,
        command: platformCommand("npm"),
        args: ["run", "test"],
        commandId: `verify-${Date.now()}-npm-run-test`
      });
    }
    verifyResultCode = result.code;
  } else if (existsSync(pyproject) || existsSync(requirements) || existsSync(setupPy)) {
    verifyCommand = "pytest";
    const result = await runCommandWithLogging({
      runJsonlPath,
      sessionLogPath,
      source: "verify",
      cwd: projectDir,
      command: "pytest",
      args: [],
      commandId: `verify-${Date.now()}-pytest`
    });
    verifyResultCode = result.code;
  } else {
    const entries = await fs.readdir(projectDir);
    const cliCandidate = entries.find((entry) => /^cli\.(js|mjs|cjs|py|ps1)$/i.test(entry));
    if (cliCandidate) {
      if (cliCandidate.endsWith(".py")) {
        verifyCommand = `python ${cliCandidate} --help`;
        const result = await runCommandWithLogging({
          runJsonlPath,
          sessionLogPath,
          source: "verify",
          cwd: projectDir,
          command: "python",
          args: [cliCandidate, "--help"],
          commandId: `verify-${Date.now()}-python-help`
        });
        verifyResultCode = result.code;
      } else if (cliCandidate.endsWith(".ps1")) {
        verifyCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File ${cliCandidate} --help`;
        const result = await runCommandWithLogging({
          runJsonlPath,
          sessionLogPath,
          source: "verify",
          cwd: projectDir,
          command: "powershell",
          args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cliCandidate, "--help"],
          commandId: `verify-${Date.now()}-powershell-help`
        });
        verifyResultCode = result.code;
      } else {
        verifyCommand = `node ${cliCandidate} --help`;
        const result = await runCommandWithLogging({
          runJsonlPath,
          sessionLogPath,
          source: "verify",
          cwd: projectDir,
          command: "node",
          args: [cliCandidate, "--help"],
          commandId: `verify-${Date.now()}-node-help`
        });
        verifyResultCode = result.code;
      }
    } else {
      skippedReason = "No package.json, python markers, or cli.* candidate found.";
      await appendJsonl(runJsonlPath, {
        ts: nowIso(),
        source: "verify",
        kind: "verify_skip",
        payload: { reason: skippedReason }
      });
    }
  }

  await appendJsonl(runJsonlPath, {
    ts: nowIso(),
    source: "verify",
    kind: "verify_end",
    payload: { command: verifyCommand, code: verifyResultCode }
  });

  return {
    passed: verifyResultCode === 0,
    command: verifyCommand,
    code: verifyResultCode,
    skipped: verifyResultCode === null,
    reason: skippedReason
  };
}
