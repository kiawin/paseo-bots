import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Other apps on this computer that keep MCP servers: the import sheet and the
// Access panel offer theirs, as {"mcpServers": {...}} JSON, to review before use.

function sources(): { label: string; path: string }[] {
  const home = homedir();
  const os = platform();
  const desktop = os === "darwin" ? join(home, "Library", "Application Support", "Claude") : os === "win32" ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude") : join(home, ".config", "Claude");
  return [
    // User-scoped servers; project ones stay with their projects.
    { label: "Claude Code", path: join(home, ".claude.json") },
    { label: "Claude Desktop", path: join(desktop, "claude_desktop_config.json") },
    { label: "Cursor", path: join(home, ".cursor", "mcp.json") },
  ];
}

const CODEX_CONFIG = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");

/** Codex's servers in the shared shape: its `http_headers` become `headers`. */
async function codexMcpServers(): Promise<Record<string, unknown>> {
  const found = codexServers(await readFile(CODEX_CONFIG(), "utf8"));
  return Object.fromEntries(Object.entries(found).map(([name, { http_headers, ...server }]) => [name, http_headers ? { ...server, headers: http_headers } : server]));
}

/** Codex keeps its servers as `[mcp_servers.<name>]` TOML tables; this reads the string, string-array and inline-table values a server uses. */
export function codexServers(toml: string): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  let target: Record<string, unknown> | null = null;
  const unquote = (text: string) => text.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  const strings = (text: string) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");
  const pairs = (text: string) => Object.fromEntries([...text.matchAll(/([\w.-]+|"[^"]*")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)].map((m) => [unquote(m[1]!), strings(m[2]!)[0]!]));
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const table = /^\[mcp_servers\.("[^"]+"|[\w-]+)(?:\.(env|http_headers))?\]$/.exec(line);
    if (table) {
      const name = unquote(table[1]!);
      const server = (servers[name] ??= {});
      target = table[2] ? (server[table[2]] = {} as Record<string, unknown>) : server;
      continue;
    }
    if (line.startsWith("[")) {
      target = null;
      continue;
    }
    const pair = /^([\w-]+)\s*=\s*(.+)$/.exec(line);
    if (!target || !pair) continue;
    const [, key, value] = pair as unknown as [string, string, string];
    if (value.startsWith("[")) target[key] = strings(value);
    else if (value.startsWith("{")) target[key] = pairs(value);
    else if (/^["']/.test(value)) target[key] = strings(value)[0];
    else target[key] = value;
  }
  return servers;
}

/** The MCP servers Claude Code, Claude Desktop, Cursor and Codex have here, each app's as `{"mcpServers": {...}}` text. */
export async function mcpSources(): Promise<{ sources: { label: string; count: number; json: string }[] }> {
  const found: { label: string; count: number; json: string }[] = [];
  const readers = [...sources().map((source) => ({ label: source.label, read: async () => (JSON.parse(await readFile(source.path, "utf8")) as { mcpServers?: unknown }).mcpServers })), { label: "Codex", read: codexMcpServers }];
  for (const source of readers) {
    try {
      const mcpServers = await source.read();
      if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) continue;
      const count = Object.keys(mcpServers).length;
      if (count) found.push({ label: source.label, count, json: JSON.stringify({ mcpServers }, null, 2) });
    } catch {
      // Not installed, or not readable.
    }
  }
  return { sources: found };
}
