import { lstatSync, readdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { avatarSvg } from "../shared/avatar";
import type { Bot } from "../shared/bot";
import { playbookRunbook, runbookFileName, RUNBOOKS_FOLDER } from "../shared/playbooks";

// The plugin SDK has no data-directory API; other plugins use
// `$PASEO_HOME/plugin-data/<plugin-id>`, so this follows that convention.
function pluginDataRoot(): string {
  return join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data");
}

export function pluginDataPath(): string {
  return join(pluginDataRoot(), "paseo-bots");
}

/**
 * The plugin was called paseo-bot before. Move its data (bots' folders, the
 * skill library, the Composio key) to the new name and leave a link behind,
 * so chats started in the old folders keep their working directory. Runs
 * once, synchronously, before anything reads the data folder.
 */
export function migrateRenamedPluginData(): void {
  const legacy = join(pluginDataRoot(), "paseo-bot");
  const target = pluginDataPath();
  try {
    if (!lstatSync(legacy).isDirectory()) return;
  } catch {
    return;
  }
  try {
    lstatSync(target);
    return;
  } catch {
    // No data under the new name yet: move the old folder over.
  }
  renameSync(legacy, target);
  symlinkSync(target, legacy, "junction");
}

/**
 * Every bot's folder: `$XDG_CONFIG_HOME/paseo/bots/<name>`. Each folder is the
 * working folder of the bot's own Paseo project, which Paseo names after the
 * folder, and holds its memory, skills, runbooks, uploads and icon.
 */
export function botsRoot(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "paseo", "bots");
}

/** The file in a bot's folder that names its bot; the folder keeps its name when the bot is renamed. */
const MARKER = ".bot-id";

/** Before 0.3 every bot had a folder named after its id in the shared "Bots" project. */
export function legacyBotsPath(): string {
  // Nested because macOS folders are case-insensitive and "bots" held per-bot folders in v0.1.
  return join(pluginDataPath(), "shared", "Bots");
}

let known: { root: string; homes: Map<string, string> } | null = null;

/** Bot id → folder name, read from the folders' markers once per root. */
function homes(): Map<string, string> {
  const root = botsRoot();
  if (known?.root === root) return known.homes;
  const found = new Map<string, string>();
  let entries: { name: string; isDirectory(): boolean }[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // No bot has a folder yet.
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    let id = "";
    try {
      id = readFileSync(join(root, entry.name, MARKER), "utf8").trim();
    } catch {
      continue;
    }
    if (id && !found.has(id)) found.set(id, entry.name);
  }
  known = { root, homes: found };
  return found;
}

/** A bot's folder, or null until it gets one (ensureBotHome). */
export function botHomeOf(botId: string): string | null {
  const name = homes().get(botId);
  return name ? join(botsRoot(), name) : null;
}

/**
 * The bot whose folder holds `path` (an agent's working folder), compared by
 * real path so links (the old Bots folders) count; null for any other folder.
 */
export async function botIdAt(path: string): Promise<string | null> {
  const [real, root] = await Promise.all([realpath(path).catch(() => null), realpath(botsRoot()).catch(() => null)]);
  if (!real || !root) return null;
  const inside = relative(root, real);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
  const name = inside.split(sep)[0];
  for (const [botId, folder] of homes()) if (folder === name) return botId;
  return null;
}

function isRealDirectory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Where a bot's files are: its folder. Until it has one, its folder from before
 * 0.3, or a holding folder whose files its first folder takes over.
 */
export function botDataPath(botId: string): string {
  const home = botHomeOf(botId);
  if (home) return home;
  const legacy = join(legacyBotsPath(), botId);
  return isRealDirectory(legacy) ? legacy : join(botsRoot(), ".pending", botId);
}

/** A folder name from a bot's name: "Scout" → "scout", "Café Bot" → "cafe-bot". */
export function folderName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "bot";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

let legacyHome: Promise<void> | null = null;

/**
 * Earlier versions used a folder called "home", which Paseo showed as a "home"
 * project. Move it to "Bots" and leave a link behind so existing chats keep
 * their working folder.
 */
export function migrateLegacyHome(): Promise<void> {
  legacyHome ??= (async () => {
    const legacy = join(pluginDataPath(), "home");
    const target = legacyBotsPath();
    const info = await lstat(legacy).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory() || (await exists(target))) return;
    await mkdir(join(target, ".."), { recursive: true });
    await rename(legacy, target);
    await symlink(target, legacy, "dir");
  })().catch((error: unknown) => console.error("paseo-bots: couldn't move the bots folder", error));
  return legacyHome;
}

/** Renames a folder, copying it when the target is on another disk. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

/** Moves what an older or holding folder kept into the bot's folder, keeping files already there. */
async function adopt(from: string, target: string): Promise<void> {
  const names = await readdir(from).catch(() => null);
  if (!names) return;
  for (const name of names) {
    const destination = join(target, name);
    if (!(await exists(destination))) await rename(join(from, name), destination);
  }
  await rm(from, { recursive: true, force: true });
}

async function createHome(bot: HomeBot): Promise<string> {
  await migrateLegacyHome();
  const existing = botHomeOf(bot.id);
  if (existing) return existing;
  const root = botsRoot();
  await mkdir(root, { recursive: true });
  const base = folderName(bot.name);
  let name = base;
  for (let n = 2; await exists(join(root, name)); n++) name = `${base}-${n}`;
  const path = join(root, name);
  const legacy = join(legacyBotsPath(), bot.id);
  if (isRealDirectory(legacy)) {
    // The marker goes in first so the folder names its bot from the moment it moves.
    await writeFile(join(legacy, MARKER), `${bot.id}\n`);
    await move(legacy, path);
    // Chats started in the old folder keep their working directory.
    await symlink(path, legacy, "dir");
  } else {
    await mkdir(path);
    await writeFile(join(path, MARKER), `${bot.id}\n`);
  }
  homes().set(bot.id, name);
  await adopt(join(root, ".pending", bot.id), path);
  // Data kept under `.bots/<id>` by v0.1.
  await adopt(join(legacyBotsPath(), ".bots", bot.id), path);
  await seedRunbooks(path, bot.playbooks);
  return path;
}

/** A new folder's first runbooks are the bot's playbooks; a folder that has runbooks keeps them. */
async function seedRunbooks(home: string, playbooks: HomeBot["playbooks"]): Promise<void> {
  const folder = join(home, RUNBOOKS_FOLDER);
  if (await exists(folder)) return;
  await mkdir(folder);
  const taken = new Set<string>();
  for (const playbook of playbooks) {
    if (!playbook.instructions.trim()) continue;
    const base = runbookFileName(playbook.name);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    await writeFile(join(folder, `${name}.md`), playbookRunbook(playbook), "utf8");
  }
}

type HomeBot = Pick<Bot, "id" | "name" | "avatar" | "playbooks">;

let creating: Promise<unknown> = Promise.resolve();

/**
 * The bot's folder, created the first time it's needed and named after the bot
 * at that moment. A bot from before 0.3 has its folder moved here, with a link
 * left at the old path. One at a time, so two bots can't take the same name.
 */
export function ensureBotHome(bot: HomeBot): Promise<{ path: string }> {
  const run = creating.then(async () => {
    const path = await createHome(bot);
    await writeBotIcon(path, bot.avatar);
    return { path };
  });
  creating = run.catch(() => undefined);
  return run;
}

/** Moves every bot's folder from before 0.3 to its own folder. */
export async function migrateBotHomes(bots: readonly Bot[]): Promise<void> {
  for (const bot of bots) {
    if (botHomeOf(bot.id) || !isRealDirectory(join(legacyBotsPath(), bot.id))) continue;
    await ensureBotHome(bot).catch((error: unknown) => console.error(`paseo-bots: couldn't move ${bot.name}'s folder`, error));
  }
}

const ICON_FILES = ["icon.svg", "icon.png"] as const;

/**
 * The project icon file for an avatar. Paseo reads SVG, PNG and ICO icons, so an
 * uploaded PNG or SVG is written as it is, and other pictures (the app stores
 * uploads as WebP) go inside an SVG clipped to the avatar's shape. Links to
 * pictures elsewhere fall back to the generated face.
 */
function iconFile(avatar: Bot["avatar"]): { name: (typeof ICON_FILES)[number]; data: Buffer } {
  const image = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(avatar.imageUrl ?? "");
  if (!image) return { name: "icon.svg", data: Buffer.from(avatarSvg(avatar)) };
  const [, type, base64] = image;
  if (type === "image/png") return { name: "icon.png", data: Buffer.from(base64!, "base64") };
  if (type === "image/svg+xml") return { name: "icon.svg", data: Buffer.from(base64!, "base64") };
  const radius = avatar.shape === "square" ? 7.68 : avatar.shape === "rounded" ? 17.92 : 32;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64" viewBox="0 0 64 64"><clipPath id="c"><rect width="64" height="64" rx="${radius}"/></clipPath><image width="64" height="64" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice" href="data:${type};base64,${base64}" xlink:href="data:${type};base64,${base64}"/></svg>`;
  return { name: "icon.svg", data: Buffer.from(svg) };
}

/**
 * Paseo shows an icon file in a project's folder as the project icon, so the
 * bot's folder gets its avatar. Rewritten only when it changes.
 */
export async function writeBotIcon(home: string, avatar: Bot["avatar"]): Promise<void> {
  const icon = iconFile(avatar);
  const current = await readFile(join(home, icon.name)).catch(() => null);
  if (!current?.equals(icon.data)) await writeFile(join(home, icon.name), icon.data);
  for (const other of ICON_FILES) if (other !== icon.name) await unlink(join(home, other)).catch(() => undefined);
}
