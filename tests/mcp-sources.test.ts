import { describe, expect, it } from "vitest";
import { codexServers } from "../server/mcp-sources";

describe("codexServers", () => {
  it("reads stdio and http servers with env and headers", () => {
    const toml = `
model = "gpt-5"

[mcp_servers.fetch]
command = "uvx"
args = ["mcp-server-fetch", "--flag"]
env = { TOKEN = "abc" }

[mcp_servers."my docs"]
url = "https://example.com/mcp"

[mcp_servers."my docs".http_headers]
Authorization = "Bearer x"

[profiles.dev]
command = "ignored"
`;
    expect(codexServers(toml)).toEqual({
      fetch: { command: "uvx", args: ["mcp-server-fetch", "--flag"], env: { TOKEN: "abc" } },
      "my docs": { url: "https://example.com/mcp", http_headers: { Authorization: "Bearer x" } },
    });
  });
});
