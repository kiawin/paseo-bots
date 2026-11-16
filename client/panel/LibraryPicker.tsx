import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { parseMcpJson, type Bot, type BotMcpServer } from "../../shared/bot";
import { addMcpServers, mcpServerTested, mcpTarget, setBotUses, updateMcpServer, type LibraryKind } from "../../shared/library";
import { mcpProbeRpc, mcpSourcesRpc } from "../../shared/rpc";
import { errorText } from "../native";
import { openLibrary } from "../navigation";
import type { PanelProps } from "./BotPanel";
import { CardNote, PressableRow, RowText, SectionLink, Switch } from "./controls";

interface LibraryPickerProps extends Pick<PanelProps, "colors" | "bot" | "library" | "onLibrary" | "onPatch"> {
  kind: LibraryKind;
  title: string;
  info: string;
}

/**
 * The library's skills or MCP servers with a switch each for this bot, like
 * OpenMausBot's per-bot Access cards. Items are added and edited on the
 * Skills & Tools page; a row opens its page there.
 */
export function LibraryPicker({ colors, bot, library, onLibrary, onPatch, kind, title, info }: LibraryPickerProps) {
  const items =
    kind === "skill"
      ? library.skills.map((skill) => ({
          id: skill.id,
          label: skill.id,
          hint: skill.description || skill.source,
          enabled: skill.enabled && skill.reviewedSha !== null,
          offHint: skill.reviewedSha === null ? "Needs review in Skills & Tools" : "Turned off in Skills & Tools",
        }))
      : library.mcpServers.map((server) => ({
          id: server.id,
          label: server.name,
          hint: server.description || mcpTarget(server.config),
          enabled: server.enabled,
          offHint: mcpServerTested(server) ? "Turned off in Skills & Tools" : "Needs a test in Skills & Tools",
        }));
  const used = kind === "skill" ? bot.skillIds : bot.mcpServerIds;
  const toggle = (id: string, on: boolean) => {
    const next: Bot = setBotUses(bot, kind, id, on);
    onPatch(kind === "skill" ? { skillIds: next.skillIds } : { mcpServerIds: next.mcpServerIds });
  };
  const noun = kind === "skill" ? "skills" : "MCP servers";
  const found = useFoundServers(kind === "mcp" ? library : null);
  const probe = useRpc(mcpProbeRpc);
  const toast = useToast();
  const [adding, setAdding] = useState<string | null>(null);

  /** Adds a server found on this computer to the library, tests it, and on success turns it on here. */
  const adopt = async (entry: FoundServer) => {
    setAdding(entry.key);
    try {
      let id = "";
      if (!(await onLibrary((current) => {
        const added = addMcpServers(current, [entry.server]);
        id = added.ids[0] ?? "";
        return added.library;
      }))) return;
      const result = await probe({ config: entry.server.config });
      const checkedAt = new Date().toISOString();
      if (!result.ok) {
        await onLibrary((current) => updateMcpServer(current, id, { checkError: result.error, checkedAt }));
        toast.show(`${entry.server.name} did not connect: ${result.error}`, { variant: "error" });
        return;
      }
      await onLibrary((current) => updateMcpServer(current, id, { tools: result.tools, checkError: null, checkedAt, enabled: true }));
      onPatch({ mcpServerIds: setBotUses(bot, "mcp", id, true).mcpServerIds });
    } catch (error) {
      toast.show(errorText(error), { variant: "error" });
    } finally {
      setAdding(null);
    }
  };

  return (
    <>
    <SettingsSection title={title} info={info} trailing={<SectionLink colors={colors} icon="ArrowUpRight" label="Skills & Tools" onPress={() => openLibrary()} />}>
      <SettingsCard>
        {items.length === 0 ? <CardNote colors={colors} text={`No ${noun} in Skills & Tools yet`} /> : null}
        {items.map((item) => (
          <PressableRow key={item.id} colors={colors} accessibilityLabel={`Open ${item.label} in Skills & Tools`} onPress={() => openLibrary({ kind, id: item.id })}>
            {({ hovered }) => (
              <>
                <RowText colors={colors} label={item.label} hint={item.enabled ? item.hint : item.offHint} hintLines={2} />
                <Switch colors={colors} label={`Use ${item.label}`} value={item.enabled && used.includes(item.id)} disabled={!item.enabled} onValueChange={(on) => toggle(item.id, on)} />
                <Icon name="ChevronRight" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
              </>
            )}
          </PressableRow>
        ))}
      </SettingsCard>
    </SettingsSection>
      {found.length > 0 ? (
        <SettingsSection title="On this computer" info="Servers Claude Code, Claude Desktop, Cursor and Codex have set up here. Switching one on adds it to Skills & Tools and tests it first; sign-in tokens stay with those apps, so a server that needs sign-in may not connect.">
          <SettingsCard>
            {found.map((entry) => (
              <PressableRow key={entry.key} colors={colors} accessibilityLabel={`Use ${entry.server.name}`} onPress={() => void adopt(entry)}>
                {() => (
                  <>
                    <RowText colors={colors} label={entry.server.name} hint={adding === entry.key ? "Connecting..." : `${entry.labels.join(", ")} · ${mcpTarget(entry.server.config)}`} hintLines={2} />
                    <Switch colors={colors} label={`Use ${entry.server.name}`} value={adding === entry.key} disabled={adding !== null} onValueChange={() => void adopt(entry)} />
                  </>
                )}
              </PressableRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}

interface FoundServer {
  key: string;
  server: BotMcpServer;
  /** The apps that have it. */
  labels: string[];
}

/** MCP servers other apps here have that the library doesn't hold yet (same name and connection). Pass null to skip. */
function useFoundServers(library: Pick<PanelProps["library"], "mcpServers"> | null): FoundServer[] {
  const readSources = useRpc(mcpSourcesRpc);
  const sources = useQuery({ queryKey: ["paseo-bots", "mcp-sources"], queryFn: () => readSources({}), enabled: library !== null });
  if (!library) return [];
  const known = new Set(library.mcpServers.map((server) => `${server.name}\n${JSON.stringify(server.config)}`));
  const found = new Map<string, FoundServer>();
  for (const source of sources.data?.sources ?? []) {
    let servers: BotMcpServer[] = [];
    try {
      servers = parseMcpJson(source.json);
    } catch {
      continue;
    }
    for (const server of servers) {
      const key = `${server.name}\n${JSON.stringify(server.config)}`;
      if (known.has(key)) continue;
      const entry = found.get(key) ?? { key, server, labels: [] };
      entry.labels.push(source.label);
      found.set(key, entry);
    }
  }
  return [...found.values()];
}
