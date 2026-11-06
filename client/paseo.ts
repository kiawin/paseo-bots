import type { getPaseoClient } from "@getpaseo/plugin/client";

// Paseo's client API types, read off the plugin SDK. Plugins get the API from the host,
// and Paseo builds a plugin without its dev dependencies, so @getpaseo/client can't be
// imported, not even for types.

export type PaseoApi = ReturnType<typeof getPaseoClient>;
export type PaseoAgent = Exclude<Parameters<PaseoApi["agents"]["ref"]>[0], string>;
