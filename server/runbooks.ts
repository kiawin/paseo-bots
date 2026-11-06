import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runbookDescription, RUNBOOKS_FOLDER } from "../shared/playbooks";
import { botDataPath } from "./bot-home";

export function runbooksFolder(botId: string): string {
  return join(botDataPath(botId), RUNBOOKS_FOLDER);
}

const FILE = /^[a-z0-9][a-z0-9._-]*\.md$/;

function runbookPath(botId: string, file: string): string {
  if (!FILE.test(file)) throw new Error(`Not a runbook file: ${file}`);
  return join(runbooksFolder(botId), file);
}

/** The bot's runbooks, by file name, with what each is for. */
export async function listRunbooks(botId: string): Promise<{ file: string; description: string; path: string }[]> {
  const folder = runbooksFolder(botId);
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => FILE.test(name)).sort();
  const runbooks: { file: string; description: string; path: string }[] = [];
  for (const file of names) {
    const path = join(folder, file);
    if (!(await stat(path).catch(() => null))?.isFile()) continue;
    runbooks.push({ file, description: runbookDescription(await readFile(path, "utf8").catch(() => "")), path });
  }
  return runbooks;
}

export async function readRunbook(botId: string, file: string): Promise<{ text: string }> {
  return { text: await readFile(runbookPath(botId, file), "utf8").catch(() => "") };
}

export async function writeRunbook(botId: string, file: string, text: string): Promise<void> {
  await mkdir(runbooksFolder(botId), { recursive: true });
  await writeFile(runbookPath(botId, file), text, "utf8");
}

export async function deleteRunbook(botId: string, file: string): Promise<void> {
  await rm(runbookPath(botId, file), { force: true });
}
