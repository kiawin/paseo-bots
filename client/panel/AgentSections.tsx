import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { APPS_MCP_NAME } from "../../shared/apps";
import { botMcpServers, toolGrants } from "../../shared/bot";
import { TOOLS_MCP_NAME } from "../../shared/bot-tools";
import { commandListRpc, commandRemoveRpc } from "../../shared/rpc";
import { useAgentProfiles, useBotHost, usePaseoTools, useProviders } from "../data";
import { errorText } from "../native";
import type { PanelProps } from "./BotPanel";
import { AdvancedToggle, CardNote, DrillRow, InputField, SectionMeta, StatusBadge, TextAreaField } from "./controls";
import { AppsPicker } from "./AppsPicker";
import { LibraryPicker } from "./LibraryPicker";

/** Shown by a select whose value isn't one of its options (SettingsSelect displays the raw value). */
const CUSTOM = "Custom";

// ---------------------------------------------------------------- access

export function AccessSection(props: PanelProps) {
  const { colors, bot, localHost, onPatch } = props;
  // Grants already set count as in use, so they show.
  const [advanced, setAdvanced] = useState(bot.alwaysAllow.length > 0);
  return (
    <>
      <PaseoToolsSection colors={colors} bot={bot} localHost={localHost} />
      <LibraryPicker {...props} kind="mcp" title="MCP servers" info="Added on top of the MCP servers the provider already loads. Paseo's own tools are always included. Add and edit servers in Skills & Tools." />
      <AppsPicker colors={colors} bot={bot} localHost={localHost} onPatch={onPatch} />
      <AdvancedToggle colors={colors} open={advanced} onToggle={() => setAdvanced(!advanced)} />
      {advanced ? <GrantsSection {...props} /> : null}
    </>
  );
}

function GrantsSection({ colors, bot, library, onPatch }: PanelProps) {
  const [allowText, setAllowText] = useState(bot.alwaysAllow.join("\n"));
  const lines = allowText.split("\n").map((line) => line.trim()).filter(Boolean);
  // Only grants for the bot's own servers are sent; Paseo rejects the rest.
  const active = new Set([...botMcpServers(bot, library).map((server) => server.name), ...(bot.apps.length ? [APPS_MCP_NAME] : []), TOOLS_MCP_NAME]);
  const grants = toolGrants(lines).filter((grant) => active.has(grant.server));
  const ignored = lines.length - grants.length;
  return (
    <SettingsSection
      title="Always allowed"
      info={'Tools from the bot\'s MCP servers it may use without asking, one "server/tool" per line. Only providers with exact tool grants (Claude, Codex, OpenCode) accept these.'}
      trailing={<SectionMeta colors={colors} text={`${grants.length} valid${ignored ? ` · ${ignored} ignored` : ""}`} tone={ignored ? "warning" : undefined} />}
    >
      <SettingsCard>
        <TextAreaField
          colors={colors}
          monospace
          accessibilityLabel="Always allowed tools"
          value={allowText}
          onChangeText={(text) => {
            setAllowText(text);
            onPatch({ alwaysAllow: text.split("\n").map((line) => line.trim()).filter(Boolean) });
          }}
          autoCapitalize="none"
          autoCorrect={false}
          minHeight={72}
          placeholder={"gmail/search_threads\nfetch/fetch"}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * Paseo adds its own tools (other agents, workspaces, terminals, schedules, the
 * browser) to every agent it starts, bots included. Whether it does is a host
 * setting, so this shows it and can turn it back on.
 */
function PaseoToolsSection({ colors, bot, localHost }: Pick<PanelProps, "colors" | "bot" | "localHost">) {
  const host = useBotHost(localHost);
  const tools = usePaseoTools(host, bot.provider);
  const [busy, setBusy] = useState(false);
  const state = tools.state;
  const label = !state ? (tools.loading ? "Checking..." : "Couldn't read the host's settings") : state.on ? "Included in every chat" : "Turned off";
  const hint = !state
    ? null
    : state.on
      ? "Other agents, workspaces, terminals, schedules and the browser"
      : state.reason === "provider"
        ? `Off for ${bot.provider} on ${host.label}`
        : state.reason === "host"
          ? `Off for every agent on ${host.label}`
          : `Paseo's MCP server is off on ${host.label}`;
  return (
    <SettingsSection title="Paseo tools" info="Paseo gives every agent it starts its own tools, bots included. Changing this changes it for all agents on the host.">
      <SettingsCard>
        {state && !state.on && state.reason !== "mcp" ? (
          <SettingsAction
            label={label}
            hint={hint ?? undefined}
            actionLabel={busy ? "Turning on..." : "Turn on"}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void tools.turnOn().finally(() => setBusy(false));
            }}
          />
        ) : (
          <SettingsRow label={label} hint={hint ?? undefined}>
            {state?.on ? <StatusBadge colors={colors} label="On" variant="success" /> : null}
          </SettingsRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------- model

export function ModelSection({ colors, bot, localHost, onPatch }: PanelProps) {
  const host = useBotHost(localHost);
  const providers = useProviders(host);
  const profiles = useAgentProfiles(host);
  const provider = providers.data?.find((entry) => entry.provider === bot.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  const model = models.find((entry) => entry.id === bot.model);
  const thinking = model?.thinkingOptions ?? models.find((entry) => entry.isDefault)?.thinkingOptions ?? [];
  const profile = (profiles.data ?? []).find((entry) => entry.provider === bot.provider && (entry.model ?? null) === bot.model);
  const providerPlaceholder = providers.isLoading ? "Loading..." : "Choose a provider";

  return (
    <>
      <SettingsSection title="Agent" info="The provider and model each new chat and routine run starts with.">
        <SettingsCard>
          <SettingsSelect
            label="Provider"
            value={bot.provider || providerPlaceholder}
            disabled={providers.isLoading}
            options={(providers.data ?? []).map((entry) => ({ label: (entry.label ?? entry.provider) + (entry.status === "ready" ? "" : ` (${entry.status})`), value: entry.provider }))}
            onValueChange={(value) => {
              const entry = providers.data?.find((candidate) => candidate.provider === value);
              onPatch({ provider: value, model: null, modeId: entry?.defaultModeId ?? null, thinkingOptionId: null });
            }}
          />
          <SettingsSelect
            label="Model"
            value={provider ? (bot.model ?? "") : "Choose a provider first"}
            disabled={!provider}
            options={provider ? [{ label: "Default", value: "" }, ...models.map((entry) => ({ label: entry.label, value: entry.id }))] : []}
            onValueChange={(value) => onPatch({ model: value || null, thinkingOptionId: null })}
          />
          {thinking.length > 0 ? (
            <SettingsSelect
              label="Thinking"
              value={bot.thinkingOptionId ?? ""}
              options={[{ label: "Default", value: "" }, ...thinking.map((option) => ({ label: option.label, value: option.id }))]}
              onValueChange={(value) => onPatch({ thinkingOptionId: value || null })}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
  
      {(profiles.data ?? []).length > 0 ? (
        <SettingsSection title="Agent profile" info="Fills in the settings above from one of the host's agent profiles.">
          <SettingsCard>
            <SettingsSelect
              label="Agent profile"
              hint="Fills in provider, model, mode and thinking"
              value={profile?.id ?? CUSTOM}
              options={profiles.data!.map((entry) => ({ label: entry.name, value: entry.id }))}
              onValueChange={(id) => {
                const chosen = profiles.data?.find((entry) => entry.id === id);
                if (chosen) onPatch({ provider: chosen.provider, model: chosen.model ?? null, modeId: chosen.modeId ?? null, thinkingOptionId: chosen.thinkingOptionId ?? null });
              }}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- permissions

export function PermissionsSection({ colors, bot, localHost, onPatch }: PanelProps) {
  const host = useBotHost(localHost);
  const providers = useProviders(host);
  const provider = providers.data?.find((entry) => entry.provider === bot.provider);
  const modes = provider?.modes ?? [];
  const current = modes.find((mode) => mode.id === (bot.modeId ?? provider?.defaultModeId));
  return (
    <>
      <SettingsSection title="Approval" info="How much the bot may do before asking you. Also applies to its routines.">
        <SettingsCard>
          <SettingsSelect
            label="Mode"
            hint={provider ? (current?.description ? `${current.label}: ${current.description}` : undefined) : "Pick a provider under Model to see its modes"}
            value={provider ? (bot.modeId ?? "") : "Choose a provider first"}
            disabled={!provider}
            options={provider ? [{ label: "Default", value: "" }, ...modes.map((mode) => ({ label: mode.label, value: mode.id }))] : []}
            onValueChange={(value) => onPatch({ modeId: value || null })}
          />
        </SettingsCard>
      </SettingsSection>
      {host.isLocal ? (
        <SettingsSection title="Other bots" info="Whether this bot may ask other bots on this host for help. Each request starts a chat under the other bot, which works with its own settings.">
          <SettingsCard>
            <SettingsSelect
              label="Contact other bots"
              hint={bot.contactBots === "ask" ? "You approve each request, when the mode asks before using tools" : bot.contactBots === "allow" ? "Without asking you first" : "Never"}
              value={bot.contactBots}
              options={[
                { label: "Ask first", value: "ask" },
                { label: "Allowed", value: "allow" },
                { label: "Off", value: "off" },
              ]}
              onValueChange={(contactBots) => onPatch({ contactBots })}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {host.isLocal ? <AllowedCommands colors={colors} bot={bot} /> : null}
    </>
  );
}

/** OpenMausBot's saved commands: each is one exact command in one folder, added from its approval card. */
function AllowedCommands({ colors, bot }: Pick<PanelProps, "colors" | "bot">) {
  const list = useRpc(commandListRpc);
  const remove = useRpc(commandRemoveRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const key = ["paseo-bots", "commands", bot.id];
  const rules = useQuery({ queryKey: key, queryFn: () => list({ botId: bot.id }) });
  const items = rules.data?.rules ?? [];
  const info = "Commands this bot runs without asking you: the exact command, in the exact folder. Add one with Always allow on the command's approval card.";
  return (
    <SettingsSection title="Commands" info={info}>
      <SettingsCard>
        <DrillRow colors={colors} label="Allowed commands" hint={rules.isLoading ? "Loading..." : items.length ? `${items.length} ${items.length === 1 ? "command" : "commands"}` : "None yet"} onPress={() => setOpen(true)} />
      </SettingsCard>
      {open ? (
        <Modal title="Allowed commands" open onOpenChange={(next) => !next && setOpen(false)}>
          <Modal.Content>
            <SettingsCard>
              {items.length === 0 ? <CardNote colors={colors} text="None yet. Add one with Always allow on a command's approval card." /> : null}
              {items.map((rule) => (
                <SettingsAction
                  key={rule.id}
                  label={rule.command}
                  hint={rule.cwd}
                  actionLabel="Remove"
                  onPress={() =>
                    void remove({ botId: bot.id, id: rule.id })
                      .then(() => queryClient.invalidateQueries({ queryKey: key }))
                      .catch((error: unknown) => toast.error(errorText(error)))
                  }
                />
              ))}
            </SettingsCard>
          </Modal.Content>
        </Modal>
      ) : null}
    </SettingsSection>
  );
}
