import type { Playbook } from "./bot";
import { parseSkillFrontmatter, sanitizeSkillName, skillMarkdown } from "./skills";

// Runbooks: step-by-step guides for a bot's recurring jobs, one Markdown file
// each in the runbooks folder of the bot's own folder. Every chat lists them,
// like skills, and the bot reads the one a job needs. Playbooks (OpenMausBot's
// trigger-word guidance, kept in the settings by templates, presets and older
// bots) become the bot's first runbooks when it gets its folder.

export const RUNBOOKS_FOLDER = "runbooks";

/** A runbook file's name (without `.md`) from its title. */
export function runbookFileName(name: string): string {
  return sanitizeSkillName(name);
}

/** A playbook as a runbook file: its triggers become the description that says when to use it. */
export function playbookRunbook(playbook: Pick<Playbook, "name" | "triggers" | "instructions">): string {
  const when = playbook.triggers.length ? `Use when the job mentions ${playbook.triggers.join(", ")}.` : `How to handle ${playbook.name}.`;
  return skillMarkdown(playbook.name.replace(/\s+/g, " ").trim(), when, playbook.instructions);
}

/** What a runbook is for: its frontmatter description, else its first line of text. */
export function runbookDescription(text: string): string {
  const description = parseSkillFrontmatter(text).description;
  if (description) return description;
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return (body.split(/\r?\n/).find((line) => line.trim()) ?? "").replace(/^#+\s*/, "").trim().slice(0, 200);
}

/** "invoice, receipt, expense report" as trigger phrases. */
export function parseTriggers(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((trigger) => trigger.trim()).filter(Boolean))].slice(0, 20);
}
