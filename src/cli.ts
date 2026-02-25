#!/usr/bin/env node

import path from "path";
import { cmdInbox } from "./inbox";
import { generateReport } from "./report";

const ROOT_DIR = process.cwd();

function usage(): string {
  return [
    "Usage:",
    "  pm inbox <project-name> \"<idea>\" [--workflow <path>]",
    "  pm report <project-name>"
  ].join("\n");
}

function parseInboxArgs(rest: string[]): { projectName: string; idea: string; workflowPath?: string } {
  const projectName = rest[0];
  const ideaTokens: string[] = [];
  let workflowPath: string | undefined;

  for (let i = 1; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--workflow") {
      const value = rest[i + 1];
      if (!value) {
        throw new Error("Missing value for --workflow.");
      }
      workflowPath = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--workflow=")) {
      workflowPath = token.slice("--workflow=".length);
      continue;
    }
    ideaTokens.push(token);
  }

  return { projectName, idea: ideaTokens.join(" ").trim(), workflowPath };
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (!command) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  try {
    if (command === "--help" || command === "-h" || command === "help") {
      console.log(usage());
      return;
    }

    if (command === "inbox") {
      const args = parseInboxArgs(rest);
      if (!args.projectName || !args.idea) {
        throw new Error("Missing arguments. Usage: pm inbox <project-name> \"<idea>\" [--workflow <path>]");
      }
      const result = await cmdInbox({
        rootDir: ROOT_DIR,
        projectName: args.projectName,
        idea: args.idea,
        workflowPath: args.workflowPath
      });
      console.log(`Status: ${result.status}`);
      console.log(`Project: ${result.projectDir}`);
      console.log(`Workflow: ${result.workflowSource}`);
      console.log(`Report hint: pm report ${args.projectName}`);
      return;
    }

    if (command === "report") {
      const projectName = rest[0];
      if (!projectName) {
        throw new Error("Missing arguments. Usage: pm report <project-name>");
      }
      const projectDir = path.join(ROOT_DIR, "projects", projectName);
      console.log(await generateReport(projectDir));
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

void main();
