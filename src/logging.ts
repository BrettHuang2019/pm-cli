import { promises as fs } from "fs";
import { EventRecord } from "./types";

export function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function appendJsonl(runJsonlPath: string, record: EventRecord): Promise<void> {
  await fs.appendFile(runJsonlPath, `${JSON.stringify(record)}\n`, "utf8");
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
