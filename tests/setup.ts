import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bots' folders live under $XDG_CONFIG_HOME; tests never touch the real one.
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "paseo-bots-config-"));
