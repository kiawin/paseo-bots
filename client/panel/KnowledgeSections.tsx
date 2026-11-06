import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { SOUL_MAX_BYTES, utf8Bytes } from "../../shared/bot";
import { runbookFileName } from "../../shared/playbooks";
import { memoryDeleteRpc, memoryListRpc, memoryReadRpc, memoryWriteRpc, runbookDeleteRpc, runbookListRpc, runbookReadRpc, runbookWriteRpc } from "../../shared/rpc";
import { skillMarkdown } from "../../shared/skills";
import { confirmDialog, errorText } from "../native";
import type { PanelProps } from "./BotPanel";
import { LibraryPicker } from "./LibraryPicker";
import { Alert, Button, CardNote, DrillRow, FormTextArea, InputField, SectionLink, SectionMeta, SheetActions, TextAreaField } from "./controls";
import { ChangesSheet, LogSheet, useDailyLog, useMemoryJournal } from "./MemoryActivity";

type Colors = PanelProps["colors"];

const kb = (bytes: number) => (bytes / 1000).toFixed(1);


// ---------------------------------------------------------------- soul

/** Paseo's "Append system prompt": a row with Edit that opens a sheet with the text, Reset and Save. */
export function SoulSection({ colors, bot, onPatch }: PanelProps) {
  const [editing, setEditing] = useState(false);
  const bytes = utf8Bytes(bot.soul);
  return (
    <>
      <SettingsSection title="Instructions" info="Comes right after the bot's identity in the system prompt and outranks memory and skills.">
        <SettingsCard>
          <SettingsAction label="Standing instructions" hint="How the bot behaves in every chat" actionLabel="Edit" onPress={() => setEditing(true)} />
          <SettingsRow
            label="Size"
            hint={bytes ? `${kb(bytes)} of ${SOUL_MAX_BYTES / 1000} KB` : "Empty"}
            error={bytes > SOUL_MAX_BYTES ? `Over the ${SOUL_MAX_BYTES / 1000} KB limit` : null}
          />
        </SettingsCard>
      </SettingsSection>
      {editing ? (
        <SoulSheet
          colors={colors}
          saved={bot.soul}
          onClose={() => setEditing(false)}
          onSave={(soul) => {
            onPatch({ soul });
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
}

function SoulSheet({ colors, saved, onClose, onSave }: { colors: Colors; saved: string; onClose(): void; onSave(soul: string): void }) {
  const [draft, setDraft] = useState(saved);
  const bytes = utf8Bytes(draft);
  const changed = draft !== saved;
  return (
    <Modal title="Standing instructions" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <FormTextArea
          colors={colors}
          accessibilityLabel="Standing instructions"
          value={draft}
          onChangeText={setDraft}
          minHeight={320}
          placeholder="You manage my email. Draft replies in my voice; never send without asking."
        />
        <SheetActions
          leading={
            <SectionMeta colors={colors} text={`${kb(bytes)} / ${SOUL_MAX_BYTES / 1000} KB`} tone={bytes > SOUL_MAX_BYTES ? "danger" : bytes > SOUL_MAX_BYTES * 0.8 ? "warning" : undefined} />
          }
        >
          <Button colors={colors} variant="ghost" label="Reset" disabled={!changed} onPress={() => setDraft(saved)} />
          <Button colors={colors} variant="default" label="Save" disabled={!changed} onPress={() => onSave(draft)} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------- skills

export function SkillsSection(props: PanelProps) {
  return <LibraryPicker {...props} kind="skill" title="Skills" info="Switched-on skills are listed in the bot's prompt and read when a task needs them. Add and edit skills in Skills & Tools." />;
}

// ---------------------------------------------------------------- memory

const TOPIC_NAME = /^[A-Za-z0-9 ._-]+$/;
const MEMORY_LINES = 200;
const MEMORY_BYTES = 24_000;

export function MemorySection({ colors, bot }: PanelProps) {
  const list = useRpc(memoryListRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"topic" | "changes" | "log" | null>(null);
  const files = useQuery({ queryKey: ["paseo-bots", "memory", bot.id], queryFn: () => list({ botId: bot.id }), refetchInterval: 20_000 });
  const journal = useMemoryJournal(bot.id);
  const log = useDailyLog(bot.id);
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: ["paseo-bots", "memory", bot.id] }), queryClient.invalidateQueries({ queryKey: ["paseo-bots", "memory-journal", bot.id] })]);

  const data = files.data;
  const over = data ? data.injectedLines > MEMORY_LINES || data.injectedBytes > MEMORY_BYTES : false;
  const changes = journal.data?.entries.length ?? 0;
  const days = log.data?.days.length ?? 0;

  return (
    <>
      <SettingsSection
        title="Files"
        info="The bot updates these itself as it learns; edit them to correct or add facts. MEMORY.md is loaded into every chat, topic files are read on demand."
        trailing={<SectionLink colors={colors} label="New topic file" onPress={() => setSheet("topic")} />}
      >
        <SettingsCard>
          {(data?.files ?? [{ name: "MEMORY.md", bytes: 0, lines: 0, topic: false }]).map((file) => (
            <DrillRow
              key={file.name}
              colors={colors}
              label={file.topic ? `memory/${file.name}` : file.name}
              hint={!data ? "Loading..." : file.topic ? `${file.lines} lines · ${kb(file.bytes)} KB` : `${data.injectedLines} of ${MEMORY_LINES} lines · ${kb(data.injectedBytes)} of ${MEMORY_BYTES / 1000} KB loaded into every chat`}
              error={!file.topic && over ? "Over the budget, so the end is left out" : null}
              hintLines={2}
              onPress={() => setOpen(file.name)}
            />
          ))}
          {data ? (
            <SettingsAction
              label="Folder"
              hint={data.folder.replace(/^\/(?:Users|home)\/[^/]+/, "~")}
              actionLabel="Copy"
              onPress={() => void copyText(data.folder).then(() => toast.show("Path copied", { variant: "success" }))}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Activity">
        <SettingsCard>
          <DrillRow colors={colors} label="Changes" hint={journal.isLoading ? "Loading..." : changes ? `${changes} ${changes === 1 ? "change" : "changes"}, with undo` : "No changes yet"} onPress={() => setSheet("changes")} />
          <DrillRow colors={colors} label="Daily log" hint={log.isLoading ? "Loading..." : days ? `${days} ${days === 1 ? "day" : "days"}` : "No entries yet"} onPress={() => setSheet("log")} />
        </SettingsCard>
      </SettingsSection>
      {sheet === "topic" ? (
        <TopicSheet
          colors={colors}
          botId={bot.id}
          onClose={() => setSheet(null)}
          onCreated={(name) => {
            setSheet(null);
            setOpen(name);
            void refresh();
          }}
        />
      ) : null}
      {sheet === "changes" ? <ChangesSheet colors={colors} bot={bot} onUndone={() => void refresh()} onClose={() => setSheet(null)} /> : null}
      {sheet === "log" ? <LogSheet colors={colors} bot={bot} onClose={() => setSheet(null)} /> : null}
      {open ? <MemorySheet colors={colors} botId={bot.id} name={open} onChanged={() => void refresh()} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** A new topic file: its name, then it opens to write in. */
function TopicSheet({ colors, botId, onClose, onCreated }: { colors: Colors; botId: string; onClose(): void; onCreated(name: string): void }) {
  const write = useRpc(memoryWriteRpc);
  const toast = useToast();
  const [topic, setTopic] = useState("");
  const name = topic.trim().replace(/\.md$/, "");
  const error = name && !TOPIC_NAME.test(name) ? "Use letters, numbers, spaces, dots and dashes" : null;
  const create = () =>
    void write({ botId, name: `${name}.md`, text: `# ${name}\n` })
      .then(() => onCreated(`${name}.md`))
      .catch((caught: unknown) => toast.error(errorText(caught)));
  return (
    <Modal title="New topic file" open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <InputField colors={colors} label="Name" hint="Letters, numbers, spaces, dots and dashes" error={error} initialValue="" placeholder="projects" onChangeText={setTopic} />
        </SettingsCard>
        <SheetActions>
          <Button colors={colors} variant="ghost" label="Cancel" onPress={onClose} />
          <Button colors={colors} variant="default" label="Create" disabled={!name || !!error} onPress={create} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

/** One memory file in a sheet. Closing with unsaved edits asks before discarding them. */
function MemorySheet({ colors, botId, name, onChanged, onClose }: { colors: Colors; botId: string; name: string; onChanged(): void; onClose(): void }) {
  const read = useRpc(memoryReadRpc);
  const write = useRpc(memoryWriteRpc);
  const remove = useRpc(memoryDeleteRpc);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const topic = name !== "MEMORY.md";
  const label = topic ? `memory/${name}` : name;
  const dirty = text !== null && text !== saved;

  useEffect(() => {
    let cancelled = false;
    void read({ botId, name })
      .then(({ text: loaded }) => {
        if (cancelled) return;
        setText(loaded);
        setSaved(loaded);
      })
      .catch((error: unknown) => !cancelled && toastRef.current.error(errorText(error)));
    return () => {
      cancelled = true;
    };
  }, [botId, name, read]);

  const close = async () => {
    if (dirty && !(await confirmDialog({ title: "Discard changes", message: `Discard your changes to ${label}?`, confirmLabel: "Discard", destructive: true }))) return;
    onClose();
  };

  const save = async () => {
    if (text === null) return;
    setSaving(true);
    try {
      // Bots edit their memory themselves; don't overwrite a change made since it was opened.
      const current = (await read({ botId, name })).text;
      if (current !== saved && current !== text) {
        toast.error("The bot changed this file since you opened it. Close it and open it again.");
        return;
      }
      await write({ botId, name, text });
      setSaved(text);
      onChanged();
      onClose();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const destroy = async () => {
    const confirmed = await confirmDialog({ title: "Delete topic file", message: `Delete ${label}? This cannot be undone.`, confirmLabel: "Delete", destructive: true });
    if (!confirmed) return;
    await remove({ botId, name });
    onChanged();
    onClose();
  };

  return (
    <Modal title={label} open onOpenChange={(value) => !value && void close()}>
      <Modal.Content>
        {text === null ? (
          <SettingsCard>
            <View style={{ minHeight: 320, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
            </View>
          </SettingsCard>
        ) : (
          <FormTextArea colors={colors} monospace accessibilityLabel={`${label} contents`} value={text} onChangeText={setText} minHeight={320} placeholder={"- Prefers short replies\n- Works Mon-Fri, CET"} />
        )}
        <SheetActions leading={topic ? <Button colors={colors} variant="ghost" label="Delete" icon="Trash2" onPress={() => void destroy()} /> : null}>
          <Button colors={colors} variant="ghost" label="Reset" disabled={!dirty || saving} onPress={() => setText(saved)} />
          <Button colors={colors} variant="default" label={saving ? "Saving..." : "Save"} disabled={!dirty || saving} onPress={() => void save()} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------- runbooks

/** Step-by-step guides for the bot's recurring jobs: Markdown files in its runbooks folder, which every chat lists. */
export function RunbooksSection({ colors, bot }: PanelProps) {
  const list = useRpc(runbookListRpc);
  const queryClient = useQueryClient();
  const key = ["paseo-bots", "runbooks", bot.id];
  const runbooks = useQuery({ queryKey: key, queryFn: () => list({ botId: bot.id }) });
  const [open, setOpen] = useState<string | "new" | null>(null);
  const changed = () => void queryClient.invalidateQueries({ queryKey: key });
  const files = runbooks.data?.runbooks ?? [];
  return (
    <>
      <SettingsSection
        title="Runbooks"
        info={`Steps for the bot's recurring jobs, one Markdown file each${runbooks.data?.folder ? ` in ${runbooks.data.folder}` : " in its folder's runbooks"}. Every chat lists them and the bot reads the one a job needs. The bot can write and improve them too.`}
        trailing={<SectionLink colors={colors} label="New runbook" onPress={() => setOpen("new")} />}
      >
        <SettingsCard>
          {runbooks.isLoading ? <CardNote colors={colors} text="Loading..." /> : files.length === 0 ? <CardNote colors={colors} text="No runbooks yet" /> : null}
          {files.map((runbook) => (
            <DrillRow key={runbook.file} colors={colors} label={runbook.file.replace(/\.md$/, "")} hint={runbook.description || "No description"} onPress={() => setOpen(runbook.file)} />
          ))}
        </SettingsCard>
      </SettingsSection>
      {open === "new" ? (
        <NewRunbookSheet colors={colors} taken={files.map((runbook) => runbook.file)} botId={bot.id} onClose={() => setOpen(null)} onCreated={(file) => {
          changed();
          setOpen(file);
        }} />
      ) : open ? (
        <RunbookSheet colors={colors} botId={bot.id} file={open} onChanged={changed} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
}

function NewRunbookSheet({ colors, botId, taken, onClose, onCreated }: { colors: Colors; botId: string; taken: readonly string[]; onClose(): void; onCreated(file: string): void }) {
  const write = useRpc(runbookWriteRpc);
  const toast = useToast();
  const [name, setName] = useState("");
  const file = `${runbookFileName(name)}.md`;
  const clash = !!name.trim() && taken.includes(file);
  const create = async () => {
    try {
      await write({ botId, file, text: skillMarkdown(name.replace(/\s+/g, " ").trim(), "When to use this runbook.", "1. ...") });
      onCreated(file);
    } catch (error) {
      toast.error(errorText(error));
    }
  };
  return (
    <Modal title="New runbook" open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label="Name" hint={name.trim() ? `Saved as runbooks/${file}` : "What job it covers"} error={clash ? "A runbook with that name exists" : null} initialValue="" placeholder="Month-end close" onChangeText={setName} />
          </SettingsCard>
        </View>
        <SheetActions>
          <Button colors={colors} variant="ghost" label="Cancel" onPress={onClose} />
          <Button colors={colors} variant="default" label="Create" disabled={!name.trim() || clash} onPress={() => void create()} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

/** One runbook file in a sheet, frontmatter and all. Closing with unsaved edits asks before discarding them. */
function RunbookSheet({ colors, botId, file, onChanged, onClose }: { colors: Colors; botId: string; file: string; onChanged(): void; onClose(): void }) {
  const read = useRpc(runbookReadRpc);
  const write = useRpc(runbookWriteRpc);
  const remove = useRpc(runbookDeleteRpc);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const label = `runbooks/${file}`;
  const dirty = text !== null && text !== saved;

  useEffect(() => {
    let cancelled = false;
    void read({ botId, file })
      .then(({ text: loaded }) => {
        if (cancelled) return;
        setText(loaded);
        setSaved(loaded);
      })
      .catch((error: unknown) => !cancelled && toastRef.current.error(errorText(error)));
    return () => {
      cancelled = true;
    };
  }, [botId, file, read]);

  const close = async () => {
    if (dirty && !(await confirmDialog({ title: "Discard changes", message: `Discard your changes to ${label}?`, confirmLabel: "Discard", destructive: true }))) return;
    onClose();
  };

  const save = async () => {
    if (text === null) return;
    setSaving(true);
    try {
      // Bots edit their runbooks themselves; don't overwrite a change made since it was opened.
      const current = (await read({ botId, file })).text;
      if (current !== saved && current !== text) {
        toast.error("The bot changed this file since you opened it. Close it and open it again.");
        return;
      }
      await write({ botId, file, text });
      setSaved(text);
      onChanged();
      onClose();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const destroy = async () => {
    if (!(await confirmDialog({ title: "Delete runbook", message: `Delete ${label}? This cannot be undone.`, confirmLabel: "Delete", destructive: true }))) return;
    await remove({ botId, file });
    onChanged();
    onClose();
  };

  return (
    <Modal title={label} open onOpenChange={(value) => !value && void close()}>
      <Modal.Content>
        {text === null ? (
          <SettingsCard>
            <View style={{ minHeight: 320, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
            </View>
          </SettingsCard>
        ) : (
          <FormTextArea colors={colors} monospace accessibilityLabel={`${label} contents`} value={text} onChangeText={setText} minHeight={320} placeholder={"---\nname: Month-end close\ndescription: Use when closing the books.\n---\n\n1. Export last month's transactions."} />
        )}
        <SheetActions leading={<Button colors={colors} variant="ghost" label="Delete" icon="Trash2" onPress={() => void destroy()} />}>
          <Button colors={colors} variant="ghost" label="Reset" disabled={!dirty || saving} onPress={() => setText(saved)} />
          <Button colors={colors} variant="default" label={saving ? "Saving..." : "Save"} disabled={!dirty || saving} onPress={() => void save()} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
