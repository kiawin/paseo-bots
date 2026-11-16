import { useEffect, useRef, useState } from "react";
import { pushHistory, type Bot } from "../shared/bot";
import { useBotSettings } from "./useBotSettings";

/** Autosave delay after the last edit in the settings panel. */
const SAVE_DELAY_MS = 600;

/**
 * Bot settings being edited: patches show at once as drafts and save shortly
 * after the last one, with a history entry for undo. The Bots screen and a bot
 * workspace's panel each hold one.
 */
export function useBotEditor() {
  const { settings, latest, commit } = useBotSettings();
  const [drafts, setDrafts] = useState<Record<string, Bot>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const pending = draftsRef.current;
    if (Object.keys(pending).length === 0) return;
    const ok = await commit((values) => {
      let history = values.history;
      const bots = values.bots.map((bot) => {
        const draft = pending[bot.id];
        if (!draft) return bot;
        history = pushHistory(history, bot);
        return draft;
      });
      return { ...values, bots, history };
    });
    if (ok) {
      setDrafts((current) => {
        const next = { ...current };
        for (const [id, bot] of Object.entries(pending)) if (next[id] === bot) delete next[id];
        return next;
      });
    }
  };

  const patchBot = (botId: string, patch: Partial<Bot>) => {
    setDrafts((current) => {
      const base = current[botId] ?? (latest.current.status === "ready" ? latest.current.values.bots.find((bot) => bot.id === botId) : undefined);
      return base ? { ...current, [botId]: { ...base, ...patch, updatedAt: new Date().toISOString() } } : current;
    });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  // Save pending edits when the editor closes.
  useEffect(() => () => void flush(), []);

  /** Applies a patch to the saved bot and to any unsaved draft of it, so autosave can't undo it. */
  const updateBot = (botId: string, patch: Partial<Bot>, recordHistory = false) => {
    setDrafts((current) => (current[botId] ? { ...current, [botId]: { ...current[botId], ...patch } } : current));
    return commit((values) => {
      const previous = values.bots.find((entry) => entry.id === botId);
      if (!previous) return values;
      return {
        ...values,
        bots: values.bots.map((entry) => (entry.id === botId ? { ...entry, ...patch, updatedAt: new Date().toISOString() } : entry)),
        history: recordHistory ? pushHistory(values.history, previous) : values.history,
      };
    });
  };

  return { settings, latest, commit, drafts, flush, patchBot, updateBot };
}
