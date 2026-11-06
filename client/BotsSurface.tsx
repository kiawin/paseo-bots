import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoAgent } from "./paseo";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, type LayoutRectangle, Platform, Text, View } from "react-native";
import { randomSeed } from "../shared/avatar";
import { applyDefaults, DEFAULT_BOT_DEFAULTS, DEFAULT_BOT_LIST_UI, EMPTY_LIBRARY, newBotId, newGroupId, presetFromBot, pushHistory, type Bot, type BotGroup, type BotListUi, type Library } from "../shared/bot";
import { saveTeam, tabOf, teamTabs, withoutBot } from "../shared/groups";
import { addImportedBots } from "../shared/library";
import { displayTitle, startBotChat } from "../shared/chat";
import { moveKey } from "../shared/sidebar";
import { chatTranscript } from "../shared/transcript";
import { botWorkspaceRpc, exportBotRpc, importBotRpc, importTeamRpc } from "../shared/rpc";
import { botFromPreset, newBot } from "../shared/templates";
import { AvatarTheme } from "./Avatar";
import { botMenuEntries, chatMenuEntries, ExportDialog, NewBotDialog, RenameDialog } from "./BotDialogs";
import { BotSidebar, type ChatMenuContext, type MenuSource, type Selection } from "./BotSidebar";
import { fullTimeline, useBotHost, useChatInvalidation, useProviders, type LocalHost } from "./data";
import { useStartSetup } from "./actions";
import { takeIntent } from "./intent";
import { LibraryView } from "./library/LibraryView";
import { onLibraryTarget, type LibraryTarget } from "./navigation";
import { Splash } from "./Splash";
import { TeamMap } from "./teams/TeamMap";
import { TeamSheet } from "./teams/TeamSheet";
import { TeamTabsRow, TeamTabSwitcher } from "./teams/TeamTabs";
import { ResizeHandle, SlideOver } from "./ui/Columns";
import { fitColumns } from "../shared/layout";
import { confirmDialog, errorText, nativeTokens } from "./native";
import { measureAnchor, MenuProvider, useMenu } from "./ui/Menu";
import { useTooltipTheme } from "./ui/Tooltip";
import { homeIndicatorInset, useKeyboardHeight } from "./keyboard";
import { BotPanel, type SectionId } from "./panel/BotPanel";
import { useBotEditor } from "./useBotEditor";
import { ui, useTypeScale } from "./typography";

type Colors = PluginTheme["colors"];



interface BotsSurfaceProps extends PluginSurfaceProps {
  /** Opens a bot's workspace with its panel in the explorer column. */
  openBotPanel(workspaceId: string): void;
}

export function BotsSurface(props: BotsSurfaceProps) {
  const { colors } = props.theme;
  useTooltipTheme(colors);
  return (
    <MenuProvider colors={colors} compact={props.layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <BotsSurfaceContent {...props} />
      </AvatarTheme>
    </MenuProvider>
  );
}


function BotsSurfaceContent({ theme, layout, host, navigation, openBotPanel }: BotsSurfaceProps) {
  const { colors } = theme;
  const { settings, latest, commit, drafts, flush, patchBot, updateBot } = useBotEditor();
  const toast = useToast();
  const menu = useMenu();
  const queryClient = useQueryClient();
  const localHost: LocalHost = { id: host.id, label: host.label };
  const localBotHost = useBotHost(localHost);
  const localProviders = useProviders(localBotHost);
  const exportBot = useRpc(exportBotRpc);
  const importBot = useRpc(importBotRpc);
  const importTeam = useRpc(importTeamRpc);
  const botWorkspace = useRpc(botWorkspaceRpc);
  const startSetup = useStartSetup(navigation, flush);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; section: SectionId | null }>({ open: false, section: null });
  const [panelVersion, setPanelVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  /** The team map fills the main pane while open. */
  const [teamMap, setTeamMap] = useState(false);
  const [editingTeam, setEditingTeam] = useState<BotGroup | "new" | null>(null);
  /** Skills & Tools replaces the bot list while open; `target` is its page (null: the list, on compact). */
  const [libraryView, setLibraryView] = useState<{ target: LibraryTarget | null } | null>(null);
  const [renaming, setRenaming] = useState<Bot | null>(null);
  const [exporting, setExporting] = useState<Bot | null>(null);
  // List state (collapsed groups, pins, order, display options) applies at once and saves behind.
  const [uiOverride, setUiOverride] = useState<BotListUi | null>(null);
  const uiRef = useRef<BotListUi | null>(null);
  const paneRef = useRef<View>(null);
  const keyboardHeight = useKeyboardHeight();
  /** The home indicator on phones; the keyboard covers it while it's up. */
  const bottomInset = keyboardHeight > 0 ? 0 : homeIndicatorInset();
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  /** Widths while a resize handle is being dragged; saved to the list UI on release. */
  const [dragWidths, setDragWidths] = useState<{ list?: number; panel?: number }>({});
  // Re-renders the whole surface when Paseo's interface/content/code sizes change.
  const typeVersion = useTypeScale();
  useChatInvalidation();

  const currentUi = (): BotListUi =>
    uiRef.current ?? (latest.current.status === "ready" ? latest.current.values.ui : undefined) ?? DEFAULT_BOT_LIST_UI;

  const updateUi = (mutate: (current: BotListUi) => BotListUi) => {
    const next = mutate(currentUi());
    uiRef.current = next;
    setUiOverride(next);
    void commit((values) => ({ ...values, ui: uiRef.current ?? next }));
  };

  /** Opens Skills & Tools. Unsaved bot edits are saved first so the library sees them. */
  const enterLibrary = (target: LibraryTarget | null) => {
    void flush();
    setLibraryView({ target });
  };

  // A bot's settings and the bot list ask for Skills & Tools through the navigation store.
  const enterLibraryRef = useRef(enterLibrary);
  enterLibraryRef.current = enterLibrary;
  useEffect(
    () =>
      onLibraryTarget((target) => {
        enterLibraryRef.current(target);
      }),
    [],
  );

  // One step back through the Bots screen, as Paseo's own screens go back: a settings page to
  // the settings list, then the settings, Skills & Tools (page, then list), and on phones the
  // team map or a chat back to the bot list. Android's Back and the phone swipes use it; with
  // nothing left to step back from, Back leaves the plugin.
  const back = useRef({ panel, compact: layout.compact, selection, teamMap, libraryView });
  back.current = { panel, compact: layout.compact, selection, teamMap, libraryView };
  const goBack = (): boolean => {
    const state = back.current;
    if (state.libraryView) {
      setLibraryView(state.compact && state.libraryView.target ? { target: null } : null);
      return true;
    }
    if (state.panel.open) {
      setPanel(state.panel.section ? { open: true, section: null } : { open: false, section: null });
      return true;
    }
    if (!state.compact) return false;
    if (state.teamMap) {
      setTeamMap(false);
      return true;
    }
    return false;
  };
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => goBackRef.current());
    return () => subscription.remove();
  }, []);

  // "New bot" from the Command Center opens a fresh Bots screen; only that one consumes it.
  useEffect(() => {
    const intent = takeIntent();
    if (intent?.kind === "new-bot") setCreating(true);
  }, []);

  if (settings.status !== "ready") {
    return (
      <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: colors.surface0, justifyContent: settings.status === "loading" ? "center" : "flex-start", alignItems: settings.status === "loading" ? "center" : "stretch" }}>
        {settings.status === "loading" ? (
          <ActivityIndicator size="large" color={colors.foregroundMuted} accessibilityLabel="Loading bots" />
        ) : (
          <Text style={{ fontSize: ui(14), color: colors.statusDanger }}>Couldn't read bots: {settings.error}</Text>
        )}
        {settings.status === "invalid" ? (
          <SettingsCard>
            <SettingsAction label="Reset bots" hint="Replaces the unreadable bot list with an empty one." actionLabel="Reset" onPress={() => void settings.reset()} />
          </SettingsCard>
        ) : null}
      </View>
    );
  }

  const listUi = uiOverride ?? settings.values.ui ?? DEFAULT_BOT_LIST_UI;
  const columns = fitColumns(
    surfaceWidth || 1600,
    dragWidths.list ?? listUi.listWidth,
    panel.open && selection ? (dragWidths.panel ?? listUi.panelWidth) : null,
  );
  const commitWidth = (key: "listWidth" | "panelWidth", width: number) => {
    setDragWidths({});
    updateUi((current) => ({ ...current, [key]: Math.round(width) }));
  };
  const allBots = settings.values.bots.map((bot) => drafts[bot.id] ?? bot);
  const library = settings.values.library ?? EMPTY_LIBRARY;
  const groups = settings.values.groups ?? [];
  const listed = allBots
    .filter((bot) => listUi.showArchived || !bot.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const selectedBot = selection ? allBots.find((bot) => bot.id === selection.botId) : undefined;
  const archivedCount = allBots.filter((bot) => bot.archived).length;
  const tabs = teamTabs(groups, listed);
  const openTab = tabs.find((tab) => tab.id === listUi.tab) ?? tabs[0] ?? null;

  // ------------------------------------------------------------ actions

  /** A bot opens in its own workspace, with its panel; its folder and project are made the first time. */
  const openBot = async (bot: Bot) => {
    try {
      await flush();
      openBotPanel((await botWorkspace({ botId: bot.id })).workspaceId);
    } catch (error) {
      toast.error(`Couldn't open ${bot.name}: ${errorText(error)}`);
    }
  };

  /** A bot row opens the bot's workspace, and a chat row the chat in Paseo's agent view. */
  const select = (next: Selection) => {
    if (next.chatId) {
      navigation?.openAgent({ agentId: next.chatId });
      return;
    }
    const bot = allBots.find((entry) => entry.id === next.botId);
    if (bot) void openBot(bot);
  };

  /** Shows a bot's settings here, its bot expanded in the list and its team's tab open. */
  const openPanel = (bot: Bot, section: SectionId | null) => {
    setSelection({ botId: bot.id, chatId: null });
    setTeamMap(false);
    setPanel({ open: true, section });
    const tab = openTab && tabOf(bot.id, groups) !== openTab.id ? tabOf(bot.id, groups) : null;
    if (tab || currentUi().collapsed.includes(bot.id)) {
      updateUi((current) => ({ ...current, tab: tab ?? current.tab, collapsed: current.collapsed.filter((id) => id !== bot.id) }));
    }
  };

  /** Saves a new bot and opens its settings; it gets its folder (named then) when it's first opened. */
  const addBot = async (bot: Bot, section: SectionId = "identity") => {
    const saved = await commit((values) => ({ ...values, bots: [...values.bots, bot] }));
    if (saved) openPanel(bot, section);
  };

  const defaultProvider = () => {
    const ready = (localProviders.data ?? []).filter((entry) => entry.status === "ready");
    return (ready.find((entry) => entry.provider === "claude") ?? ready[0])?.provider ?? "";
  };

  const duplicate = async (bot: Bot) => {
    await flush();
    const { json } = await exportBot({ bot, includeMemory: false });
    const { bot: copy } = await importBot({ botId: newBotId(), json });
    // Same library items as the original; the copy's own file only carries redacted server settings.
    await addBot({
      ...copy,
      name: `${bot.name} copy`,
      alwaysAllow: bot.alwaysAllow,
      skillIds: bot.skillIds,
      mcpServerIds: bot.mcpServerIds,
      avatar: { ...bot.avatar, seed: randomSeed() },
    });
  };

  const remove = async (bot: Bot) => {
    const ok = await commit((values) => ({
      ...values,
      bots: values.bots.filter((entry) => entry.id !== bot.id),
      history: values.history.filter((entry) => entry.botId !== bot.id),
      groups: withoutBot(values.groups ?? [], bot.id, new Date().toISOString()),
    }));
    if (!ok) return;
    if (selection?.botId === bot.id) setSelection(null);
    updateUi((current) => {
      const { [bot.id]: _order, ...chatOrder } = current.chatOrder;
      return {
        ...current,
        collapsed: current.collapsed.filter((id) => id !== bot.id),
        pinnedChats: current.pinnedChats.filter((pin) => pin.botId !== bot.id),
        chatOrder,
      };
    });
  };

  /**
   * Swaps a bot with its neighbour as the list shows it: on a team's tab within the team,
   * whose Chief of Staff stays first; otherwise among the listed bots, where pinned and
   * unpinned bots keep their own runs.
   */
  const moveBot = (bot: Bot, delta: -1 | 1): (() => void) | undefined => {
    const shown = openTab?.bots ?? listed;
    const index = shown.findIndex((entry) => entry.id === bot.id);
    const neighbour = shown[index + delta];
    if (index === -1 || !neighbour) return undefined;
    const swap = (ids: readonly string[]) => ids.map((id) => (id === bot.id ? neighbour.id : id === neighbour.id ? bot.id : id));
    const group = openTab?.group;
    if (group) {
      if (bot.id === group.leadId || neighbour.id === group.leadId) return undefined;
      return () =>
        void commit((values) => ({
          ...values,
          groups: (values.groups ?? []).map((entry) => (entry.id === group.id ? { ...entry, memberIds: swap(entry.memberIds), updatedAt: new Date().toISOString() } : entry)),
        }));
    }
    if (neighbour.pinned !== bot.pinned) return undefined;
    return () =>
      void commit((values) => {
        const order = swap(values.bots.map((entry) => entry.id));
        return { ...values, bots: order.map((id) => values.bots.find((entry) => entry.id === id)!) };
      });
  };

  const copy = (text: string, done: string) =>
    void copyText(text)
      .then(() => toast.show(done, { variant: "success" }))
      .catch(() => toast.error("Unable to copy"));

  const openBotMenu = (bot: Bot, anchor: LayoutRectangle, source: MenuSource) => {
    menu.open({
      anchor,
      align: source === "kebab" ? "end" : "start",
      width: 220,
      title: "Bot actions",
      entries: botMenuEntries({
        bot,
        onOpenInPaseo: () => void openBot(bot),
        onOpenSettings: () => openPanel(bot, "identity"),
        onTogglePin: () => void updateBot(bot.id, { pinned: !bot.pinned }),
        onMoveUp: moveBot(bot, -1),
        onMoveDown: moveBot(bot, 1),
        onRename: () => setRenaming(bot),
        onDuplicate: () => duplicate(bot).catch((error: unknown) => toast.error(`Couldn't duplicate: ${errorText(error)}`)),
        onExport: () => setExporting(bot),
        onCopyId: () => copy(bot.id, "Bot ID copied"),
        onSaveAsPreset: () =>
          void flush()
            .then(() => commit((values) => ({ ...values, presets: [...(values.presets ?? []), presetFromBot(values.bots.find((entry) => entry.id === bot.id) ?? bot)] })))
            .then((saved) => saved && toast.show(`Saved ${bot.name} as a preset. It's under New bot.`, { variant: "success" })),
        onToggleArchive: () => void updateBot(bot.id, { archived: !bot.archived }),
        onDelete: async () => {
          const confirmed = await confirmDialog({
            title: "Delete bot?",
            message: `Delete "${bot.name}"?\n\nIts chats stay on the host and remain in Paseo's history.`,
            confirmLabel: "Delete",
            cancelLabel: "Cancel",
            destructive: true,
          });
          if (confirmed) await remove(bot);
        },
      }),
    });
  };

  const deleteTeam = async (group: BotGroup) => {
    const confirmed = await confirmDialog({ title: "Delete team?", message: `Delete the "${group.name}" team? Its bots stay, without a team.`, confirmLabel: "Delete", cancelLabel: "Cancel", destructive: true });
    if (!confirmed) return false;
    await commit((values) => ({ ...values, groups: (values.groups ?? []).filter((entry) => entry.id !== group.id) }));
    return true;
  };

  const openTeamMenu = (group: BotGroup, anchor: LayoutRectangle) =>
    menu.open({
      anchor,
      align: "end",
      width: 200,
      title: "Team actions",
      entries: [
        { label: "Edit team", icon: "Pencil", onSelect: () => setEditingTeam(group) },
        { label: "Team map", icon: "Network", onSelect: () => setTeamMap(true) },
        { kind: "separator" },
        { label: "Delete team", icon: "Trash2", destructive: true, onSelect: () => void deleteTeam(group) },
      ],
    });

  const openChatMenu = (bot: Bot, chat: PaseoAgent, anchor: LayoutRectangle, source: MenuSource, context: ChatMenuContext) => {
    const botHost = localBotHost;
    const move = (delta: -1 | 1) => {
      const order = moveKey(context.siblings, chat.id, delta);
      return order ? () => updateUi((current) => ({ ...current, chatOrder: { ...current.chatOrder, [bot.id]: order } })) : undefined;
    };
    const unpin = (current: BotListUi) => ({ ...current, pinnedChats: current.pinnedChats.filter((pin) => pin.chatId !== chat.id) });
    const openAgent = navigation?.openAgent;
    menu.open({
      anchor,
      align: source === "kebab" ? "end" : "start",
      width: 260,
      title: "Chat actions",
      entries: chatMenuEntries({
        pinned: context.pinned,
        onCopyPath: () => (chat.cwd ? copy(chat.cwd, "Path copied") : toast.error("Chat path not available")),
        onCopyId: () => copy(chat.id, "Chat ID copied"),
        onCopyTranscript: async () => {
          if (!botHost.api) {
            toast.error("Host is not connected");
            return;
          }
          try {
            const entries = await fullTimeline(botHost.api, chat.id);
            await copyText(chatTranscript({ title: displayTitle(chat.title), botName: bot.name, entries, exportedAt: new Date() }));
            toast.show("Transcript copied", { variant: "success" });
          } catch (error) {
            toast.error(`Couldn't copy the transcript: ${errorText(error)}`);
          }
        },
        onTogglePin: () =>
          updateUi((current) =>
            context.pinned ? unpin(current) : { ...current, pinnedChats: [...current.pinnedChats, { botId: bot.id, chatId: chat.id }] },
          ),
        move: context.pinned || listUi.chatSort !== "manual" ? null : { up: move(-1), down: move(1) },
        onOpenInPaseo: openAgent ? () => openAgent({ agentId: chat.id }) : undefined,
        onArchive: async () => {
          if (!botHost.api) {
            toast.error("Host is not connected");
            return;
          }
          try {
            await botHost.api.agents.ref(chat.id).archive();
            if (context.pinned) updateUi(unpin);
            await queryClient.invalidateQueries({ queryKey: ["paseo-bots", "chats", botHost.key, bot.id] });
          } catch (error) {
            toast.error(`Failed to archive chat: ${errorText(error)}`);
          }
        },
      }),
    });
  };

  const openDisplayMenu = (anchor: LayoutRectangle) => {
    menu.open({
      anchor,
      align: "end",
      width: 232,
      title: "Display",
      entries: [
        {
          label: "Archived bots",
          trailing: listUi.showArchived ? "Shown" : archivedCount ? `Hidden (${archivedCount})` : "Hidden",
          onSelect: () => updateUi((current) => ({ ...current, showArchived: !current.showArchived })),
        },
        {
          label: "Chat order",
          trailing: listUi.chatSort === "manual" ? "Manual" : "Last activity",
          onSelect: () => updateUi((current) => ({ ...current, chatSort: current.chatSort === "manual" ? "activity" : "manual" })),
        },
      ],
    });
  };

  /** The chat header's bot menu has no anchor of its own; hang it from the pane's top-right corner. */
  const openBotMenuFromPane = (bot: Bot) =>
    void measureAnchor(paneRef).then((rect) =>
      openBotMenu(bot, rect ? { x: rect.x + rect.width - 44, y: rect.y, width: 36, height: 36 } : { x: 0, y: 0, width: 0, height: 0 }, "kebab"),
    );

  const sidebar = (
    <BotSidebar
      colors={colors}
      bots={listed}
      openTab={openTab}
      hiddenArchivedCount={listUi.showArchived ? 0 : archivedCount}
      selection={selection}
      ui={listUi}
      localHost={localHost}
      touch={layout.compact || layout.platform !== "web"}
      splash={layout.compact}
      bottomInset={bottomInset}
      onToggle={(botId) =>
        updateUi((current) => ({
          ...current,
          collapsed: current.collapsed.includes(botId) ? current.collapsed.filter((id) => id !== botId) : [...current.collapsed, botId],
        }))
      }
      onTogglePinnedSection={() => updateUi((current) => ({ ...current, pinnedCollapsed: !current.pinnedCollapsed }))}
      onShowArchived={() => updateUi((current) => ({ ...current, showArchived: true }))}
      onSelect={select}
      onNewBot={() => setCreating(true)}
      onBotMenu={openBotMenu}
      onChatMenu={openChatMenu}
      onDisplayMenu={openDisplayMenu}
      onEditTeam={setEditingTeam}
      onTeamMap={() => setTeamMap(true)}
    />
  );

  const tabProps = openTab
    ? { colors, tabs, openTab, onTab: (tab: string) => updateUi((current) => ({ ...current, tab })), onTeamMenu: openTeamMenu, onNewTeam: () => setEditingTeam("new" as const) }
    : null;

  const pane = teamMap ? (
    <TeamMap
      colors={colors}
      groups={groups}
      bots={allBots}
      localHost={localHost}
      compact={layout.compact}
      bottomInset={bottomInset}
      onBack={layout.compact ? () => setTeamMap(false) : undefined}
      onNewTeam={() => setEditingTeam("new")}
      onEditTeam={setEditingTeam}
      onOpenBot={(bot) => openPanel(bot, "overview")}
    />
  ) : (
      <Splash colors={colors} />
    );

  const settingsPanel =
    selectedBot && panel.open ? (
      <BotPanel
        key={`${selectedBot.id}:${panelVersion}`}
        colors={colors}
        compact={layout.compact}
        bottomInset={bottomInset}
        bot={selectedBot}
        localHost={localHost}
        history={settings.values.history}
        library={library}
        groups={groups}
        section={panel.section}
        onSection={(section) => setPanel({ open: true, section })}
        onClose={() => setPanel({ open: false, section: panel.section })}
        onPatch={(patch) => patchBot(selectedBot.id, patch)}
        flush={flush}
        onRestore={(snapshot) => {
          patchBot(selectedBot.id, snapshot);
          setPanelVersion((version) => version + 1);
          toast.show("Restored. Undo it from History if needed.", { variant: "success" });
        }}
        onSetup={() => void startSetup(selectedBot)}
        onOpenChat={(chatId) => navigation?.openAgent({ agentId: chatId })}
      />
    ) : null;

  const libraryScreen = libraryView ? (
    <LibraryView
      colors={colors}
      layout={layout}
      bottomInset={bottomInset}
      values={settings.values}
      commit={commit}
      target={libraryView.target}
      onTarget={(target) => setLibraryView({ target })}
      onBack={() => setLibraryView(null)}
    />
  ) : null;

  // On desktop Skills & Tools takes over the screen, like Paseo's settings.
  if (libraryScreen && !layout.compact) {
    return <View style={{ flex: 1, backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}>{libraryScreen}</View>;
  }

  return (
    <>
    {/* The host gives plugin surfaces no keyboard handling; lift everything above the keyboard. */}
    <View
      style={{ flex: 1, backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}
      onLayout={(event) => setSurfaceWidth(event.nativeEvent.layout.width)}
    >
      {layout.compact ? (
        <View ref={paneRef} collapsable={false} style={{ flex: 1 }}>
          {tabProps ? <TeamTabSwitcher {...tabProps} /> : null}
          {sidebar}
          {teamMap ? <SlideOver onClose={() => setTeamMap(false)}>{pane}</SlideOver> : null}
          {settingsPanel ? (
            <SlideOver onClose={() => setPanel({ open: false, section: null })} onBack={() => (panel.section ? goBack() : false)}>
              {settingsPanel}
            </SlideOver>
          ) : null}
          {libraryScreen ? <SlideOver onClose={() => setLibraryView(null)}>{libraryScreen}</SlideOver> : null}
        </View>
      ) : (
        <>
          {tabProps ? <TeamTabsRow {...tabProps} /> : null}
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View style={{ width: columns.list, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: nativeTokens(colors).surfaceSidebar }}>
              {sidebar}
              <ResizeHandle side="right" width={columns.list} onResize={(width) => setDragWidths((current) => ({ ...current, list: width }))} onCommit={(width) => commitWidth("listWidth", width)} />
            </View>
            <View ref={paneRef} collapsable={false} style={{ flex: 1, minWidth: 0 }}>{pane}</View>
            {settingsPanel && columns.panel !== null ? (
              <View style={{ width: columns.panel, borderLeftWidth: 1, borderLeftColor: colors.border }}>
                {settingsPanel}
                <ResizeHandle side="left" width={columns.panel} onResize={(width) => setDragWidths((current) => ({ ...current, panel: width }))} onCommit={(width) => commitWidth("panelWidth", width)} />
              </View>
            ) : null}
          </View>
        </>
      )}

      {editingTeam ? (
        <TeamSheet
          colors={colors}
          group={editingTeam === "new" ? null : editingTeam}
          groups={groups}
          bots={allBots}
          onClose={() => setEditingTeam(null)}
          onSave={(draft) => {
            const id = editingTeam === "new" ? null : editingTeam.id;
            const teamId = id ?? newGroupId();
            setEditingTeam(null);
            // A new team opens in its tab.
            void commit((values) => ({ ...values, groups: saveTeam(values.groups ?? [], id, draft, teamId, new Date().toISOString()) })).then((saved) => saved && !id && updateUi((current) => ({ ...current, tab: teamId })));
          }}
          onDelete={editingTeam === "new" ? undefined : () => void deleteTeam(editingTeam).then((deleted) => deleted && setEditingTeam(null))}
        />
      ) : null}
      {creating ? (
        <NewBotDialog
          colors={colors}
          onClose={() => setCreating(false)}
          presets={settings.status === "ready" ? (settings.values.presets ?? []) : []}
          onCreate={(start) => {
            setCreating(false);
            const bot = start?.preset ? botFromPreset(defaultProvider(), start.preset) : newBot(defaultProvider(), start?.template);
            const defaults = (settings.status === "ready" ? settings.values.defaults : undefined) ?? DEFAULT_BOT_DEFAULTS;
            void addBot(applyDefaults(bot, defaults, defaultProvider()), start ? "overview" : "identity");
          }}
          onImport={async (json) => {
            const { bots, teams } = await importTeam({ json });
            setCreating(false);
            const saved = await commit((values) => addImportedBots(values, bots, teams));
            const first = bots[0]?.bot;
            if (saved && first) {
              openPanel(first, "overview");
              if (bots.length > 1) toast.show(`Added ${bots.length} bots`, { variant: "success" });
            }
          }}
        />
      ) : null}

      {renaming ? (
        <RenameDialog
          colors={colors}
          title="Rename bot"
          initialValue={renaming.name}
          placeholder={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            if (!(await updateBot(renaming.id, { name }, true))) throw new Error("Unable to save");
            // The identity section holds its own copy of the name.
            if (panel.open && selection?.botId === renaming.id) setPanelVersion((version) => version + 1);
          }}
        />
      ) : null}

      {exporting ? <ExportDialog colors={colors} bot={exporting} onClose={() => setExporting(null)} /> : null}
    </View>
    </>
  );
}
