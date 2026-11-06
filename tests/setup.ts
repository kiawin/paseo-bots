import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Bots' folders live under $XDG_CONFIG_HOME; tests never touch the real one.
const config = mkdtempSync(join(tmpdir(), "paseo-bots-config-"));
process.env.XDG_CONFIG_HOME = config;
afterAll(() => rmSync(config, { recursive: true, force: true }));
