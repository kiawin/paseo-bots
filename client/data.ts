import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { PaseoAgent, PaseoApi } from "./paseo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { listBotChats } from "../shared/chat";
import { botHomeRpc } from "../shared/rpc";
import { paseoToolsState, type PaseoToolsConfig } from "../shared/paseo-tools";

export interface LocalHost {
  id: string;
  label: string;
}

export interface BotHost {
  api: PaseoApi | null;
  /** Stable key for queries; the local host uses its own id. */
  key: string;
  label: string;
}

/** The host that stores the bots, where every bot runs. */
export function useBotHost(local: LocalHost): BotHost {
  const api = usePaseo();
  return useMemo(() => ({ api, key: local.id, label: local.label }), [api, local.id, local.label]);
}

export function useProviders(host: BotHost) {
  return useQuery({
    queryKey: ["paseo-bots", "providers", host.key],
    enabled: !!host.api,
    staleTime: 60_000,
    queryFn: async () => {
      const snapshot = await host.api!.providers.snapshot();
      return snapshot.entries.filter((entry) => entry.enabled);
    },
  });
}

export function useAgentProfiles(host: BotHost) {
  return useQuery({
    queryKey: ["paseo-bots", "profiles", host.key],
    enabled: !!host.api,
    staleTime: 60_000,
    queryFn: async () => (await host.api!.config.get()).config.agentProfiles ?? [],
  });
}

export function useBotChats(host: BotHost, botId: string) {
  const botHome = useRpc(botHomeRpc);
  return useQuery({
    queryKey: ["paseo-bots", "chats", host.key, botId],
    enabled: !!host.api,
    // The host pushes agent updates (useChatInvalidation).
    queryFn: async (): Promise<PaseoAgent[]> => {
      const { path } = await botHome({ botId });
      return (await listBotChats(host.api!, botId, path)).filter((agent) => !agent.archivedAt);
    },
  });
}

/** Refetches chat lists shortly after any agent update, so chats routines start show up too. */
export function useChatInvalidation() {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let subscription: { release(): Promise<void> } | null = null;
    const unsubscribe = paseo.agents.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: ["paseo-bots", "chats"] });
      }, 500);
    });
    // The daemon only sends agent updates to sessions that subscribed through a list request.
    void paseo.agents
      .list({ page: { limit: 1 }, subscribe: {} })
      .then((result) => {
        if (closed) void result.subscription.release();
        else subscription = result.subscription;
      })
      .catch(() => {});
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      void subscription?.release();
    };
  }, [paseo, queryClient]);
}

/** The host's Paseo-tools settings for a provider, and a way to turn them on. */
export function usePaseoTools(host: BotHost, provider: string) {
  const queryClient = useQueryClient();
  const key = ["paseo-bots", "paseo-tools", host.key];
  const config = useQuery({
    queryKey: key,
    enabled: !!host.api,
    staleTime: 30_000,
    queryFn: async () => (await host.api!.config.get()).config as PaseoToolsConfig,
  });
  const state = config.data ? paseoToolsState(config.data, provider) : null;
  const turnOn = async () => {
    if (!host.api || !state || state.on) return;
    await host.api.config.patch(state.reason === "provider" ? { providers: { [provider]: { paseoTools: { enabled: true } } } } : { mcp: { injectIntoAgents: true } });
    await queryClient.invalidateQueries({ queryKey: key });
  };
  return { state, loading: config.isLoading, turnOn };
}

type TimelinePage = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>;
type ChatEntry = TimelinePage["entries"][number];

/** A chat's whole timeline, oldest first, page by page (a transcript needs all of it). */
export async function fullTimeline(api: PaseoApi, agentId: string): Promise<ChatEntry[]> {
  const handle = api.agents.ref(agentId);
  const bySeq = new Map<number, ChatEntry>();
  let page = await handle.timeline.refetch({ direction: "tail", projection: "projected", limit: 200 });
  for (let pages = 0; ; pages++) {
    if (page.error) throw new Error(page.error);
    for (const entry of page.entries) bySeq.set(entry.seqStart, entry);
    if (pages >= 100 || page.entries.length === 0 || !page.hasOlder || !page.startCursor) break;
    page = await handle.timeline.refetch({ direction: "before", cursor: page.startCursor, projection: "projected", limit: 200 });
  }
  return [...bySeq.values()].sort((a, b) => a.seqStart - b.seqStart);
}
