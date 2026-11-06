import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { botWorkspacesRpc } from "../shared/rpc";
import { Avatar } from "./Avatar";

/**
 * A button with the bot's avatar in the header of each bot's workspace, which
 * opens the bot's panel. Header buttons belong to one workspace each, so the
 * set follows the bots' workspaces as they appear, get renamed or go away.
 */
export function installBotHeaderButtons(client: PluginClientContext, open: (workspaceId: string) => void): { refresh(): void; remove(): void } {
  const buttons = new Map<string, { registration: PluginButtonRegistration; name: string; avatar: string }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const sync = async () => {
    const { workspaces } = await client.rpc(botWorkspacesRpc, {});
    if (stopped) return;
    const seen = new Set<string>();
    for (const { workspaceId, name, avatar } of workspaces) {
      seen.add(workspaceId);
      const look = { title: name, icon: ({ size }: { size: number }) => <Avatar avatar={avatar} size={size} /> };
      const existing = buttons.get(workspaceId);
      const avatarKey = JSON.stringify(avatar);
      if (existing) {
        if (existing.name !== name || existing.avatar !== avatarKey) existing.registration.update(look);
        buttons.set(workspaceId, { ...existing, name, avatar: avatarKey });
        continue;
      }
      // Button ids are per workspace and allow only [a-z0-9-], so every bot workspace uses "bot".
      const registration = client.addHeaderButton({ id: "bot", workspaceId, button: { ...look, behavior: { kind: "action", onPress: () => open(workspaceId) } } });
      buttons.set(workspaceId, { registration, name, avatar: avatarKey });
    }
    for (const [workspaceId, button] of buttons) {
      if (seen.has(workspaceId)) continue;
      button.registration.remove();
      buttons.delete(workspaceId);
    }
  };
  const run = () => void sync().catch((error: unknown) => console.error("paseo-bots: couldn't update the bots' header buttons", error));
  const later = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, 500);
  };

  run();
  // A bot's workspace is created, renamed (with the bot) or archived.
  const unsubscribe = client.paseo.workspaces.subscribe(later);
  // The daemon only streams workspace updates to clients that subscribed through a list request.
  let subscription: { release(): Promise<void> } | null = null;
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then((result) => {
      if (stopped) void result.subscription.release();
      else subscription = result.subscription;
    })
    .catch(() => undefined);
  return {
    /** Picks up a bot workspace made just now, e.g. by opening the bot. */
    refresh: run,
    remove() {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      void subscription?.release();
      for (const button of buttons.values()) button.registration.remove();
      buttons.clear();
    },
  };
}
