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
  const found = useFoundServers(kind === "mcp");
  const fromComputer = new Set(found.map((entry) => entry.key));
  const items =
    kind === "skill"
      ? library.skills.map((skill) => ({
          id: skill.id,
          label: skill.id,
          hint: skill.description || skill.source,
          enabled: skill.enabled && skill.reviewedSha !== null,
          offHint: skill.reviewedSha === null ? "Needs review in Skills & Tools" : "Turned off in Skills & Tools",
        }))
      : library.mcpServers.filter((server) => !fromComputer.has(server.name)).map((server) => ({
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
  const probe = useRpc(mcpProbeRpc);
  const toast = useToast();
  const [adding, setAdding] = useState<string | null>(null);

  /** Adds a server found on this computer to the library (once), tests it, and on success turns it on here. */
  const adopt = async (entry: FoundServer) => {
    setAdding(entry.key);
    try {
      let id = library.mcpServers.find((server) => server.name === entry.key)?.id ?? "";
      if (!id && !(await onLibrary((current) => {
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
      {kind === "mcp" && (bot.provider === "claude" || bot.provider === "codex") ? (
        <SettingsSection title={bot.provider === "claude" ? "claude.ai connectors" : "ChatGPT apps"} info={`${bot.provider === "claude" ? "Claude Code loads the connectors you've connected on claude.ai" : "Codex loads the apps connected to your ChatGPT account"} (Drive, Gmail, GitHub...) from your account, so the bot can read and act on them. It applies to new chats; one already open keeps what it had.`}>
          <SettingsCard>
            <PressableRow colors={colors} accessibilityLabel="Use account connectors" onPress={() => onPatch({ connectors: !bot.connectors })}>
              {() => (
                <>
                  <RowText colors={colors} label={bot.provider === "claude" ? "Use my claude.ai connectors" : "Use my ChatGPT apps"} hint="Every one on your account, not one by one" hintLines={2} />
                  <Switch colors={colors} label="Use account connectors" value={bot.connectors} onValueChange={(on) => onPatch({ connectors: on })} />
                </>
              )}
            </PressableRow>
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {found.length > 0 ? (
        <SettingsSection title="On this computer" info="Servers Claude Code, Claude Desktop, Cursor and Codex have set up here. Switching one on adds it to Skills & Tools, tests it first, and keeps it here; sign-in tokens stay with those apps, so a server that needs sign-in may not connect.">
          <SettingsCard>
            {found.map((entry) => {
              const added = library.mcpServers.find((server) => server.name === entry.key);
              const ready = added !== undefined && added.enabled;
              const flip = (on: boolean) => (ready ? toggle(added.id, on) : void adopt(entry));
              return (
                <PressableRow key={entry.key} colors={colors} accessibilityLabel={`Use ${entry.server.name}`} onPress={() => flip(!(ready && used.includes(added.id)))}>
                  {() => (
                    <>
                      <RowText colors={colors} label={entry.server.name} hint={adding === entry.key ? "Connecting..." : `${entry.labels.join(", ")} · ${mcpTarget(entry.server.config)}`} hintLines={2} />
                      <Switch colors={colors} label={`Use ${entry.server.name}`} value={adding === entry.key || (ready && used.includes(added.id))} disabled={adding !== null} onValueChange={flip} />
                    </>
                  )}
                </PressableRow>
              );
            })}
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

/** MCP servers other apps here have, one per name: the first app's setup, with every app that has it listed. Pass false to skip. */
function useFoundServers(enabled: boolean): FoundServer[] {
  const readSources = useRpc(mcpSourcesRpc);
  const sources = useQuery({ queryKey: ["paseo-bots", "mcp-sources"], queryFn: () => readSources({}), enabled });
  const found = new Map<string, FoundServer>();
  for (const source of sources.data?.sources ?? []) {
    let servers: BotMcpServer[] = [];
    try {
      servers = parseMcpJson(source.json);
    } catch {
      continue;
    }
    for (const server of servers) {
      const entry = found.get(server.name) ?? { key: server.name, server, labels: [] };
      entry.labels.push(source.label);
      found.set(server.name, entry);
    }
  }
  return [...found.values()];
}
