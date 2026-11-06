// Tool call details and diffs, ported from Paseo: detail state from
// app/src/utils/tool-call-detail-state.ts, diffs from app/src/utils/tool-call-parsers.ts.

export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: string;
      content?: string;
      filePaths?: string[];
      webResults?: { title: string; url: string }[];
      annotations?: string[];
    }
  | { type: "fetch"; url: string; prompt?: string; result?: string; code?: number; codeText?: string }
  | { type: "worktree_setup"; worktreePath: string; branchName: string; log: string }
  | { type: "sub_agent"; subAgentType?: string; description?: string; childSessionId?: string; log: string }
  | { type: "plain_text"; label?: string; text?: string; icon?: string }
  | { type: "plan"; text: string }
  | { type: "unknown"; input: unknown; output: unknown };

// ---------------------------------------------------------------- detail state

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === "object") return Object.values(value).some(hasMeaningfulValue);
  return true;
}

export function hasMeaningfulToolCallDetail(detail: ToolCallDetail | undefined): boolean {
  if (!detail) return false;
  switch (detail.type) {
    case "shell":
      return true;
    case "read":
    case "write":
      return Boolean(detail.filePath || detail.content);
    case "edit":
      return Boolean(detail.filePath || detail.unifiedDiff || detail.oldString || detail.newString);
    case "search":
      return Boolean(detail.query.trim() || detail.content || detail.filePaths?.length || detail.webResults?.length || detail.annotations?.length);
    case "fetch":
      return Boolean(detail.url || detail.result || detail.codeText);
    case "worktree_setup":
      return Boolean(detail.branchName || detail.worktreePath || detail.log);
    case "sub_agent":
      return Boolean(detail.subAgentType || detail.description || detail.log);
    case "plain_text":
      return Boolean(detail.label || detail.text);
    case "plan":
      return detail.text.trim().length > 0;
    case "unknown":
      return hasMeaningfulValue(detail.input) || hasMeaningfulValue(detail.output);
  }
}

export type PlanOutcome = "pending" | "approved" | "rejected" | "canceled";

// ---------------------------------------------------------------- diffs

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  segments?: DiffSegment[];
}

function splitLines(text: string): string[] {
  return text ? text.replace(/\r\n/g, "\n").split("\n") : [];
}

function splitWords(text: string): string[] {
  return text.match(/\w+|[^\w]+/g) ?? [];
}

/** Longest-common-subsequence lengths: table[i][j] covers a[i..] and b[j..]. */
export function lcsTable<T>(a: readonly T[], b: readonly T[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

function wordDiff(oldLine: string, newLine: string): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const a = splitWords(oldLine);
  const b = splitWords(newLine);
  const table = lcsTable(a, b);
  const inA = new Set<number>();
  const inB = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inA.add(i++);
      inB.add(j++);
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  const build = (words: string[], kept: Set<number>) => {
    const segments: DiffSegment[] = [];
    words.forEach((word, index) => {
      const changed = !kept.has(index);
      const last = segments[segments.length - 1];
      if (last && last.changed === changed) last.text += word;
      else segments.push({ text: word, changed });
    });
    return segments;
  };
  return { oldSegments: build(a, inA), newSegments: build(b, inB) };
}

/** Line diff of an edit's old and new strings, with word-level segments on replaced lines. */
export function buildLineDiff(original: string, updated: string): DiffLine[] {
  const a = splitLines(original);
  const b = splitLines(updated);
  if (a.length === 0 && b.length === 0) return [];
  // Large edits skip the quadratic diff and show removal then addition.
  if (a.length * b.length > 250_000) {
    return [...a.map((line) => ({ type: "remove" as const, content: `-${line}` })), ...b.map((line) => ({ type: "add" as const, content: `+${line}` }))];
  }
  const table = lcsTable(a, b);
  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      diff.push({ type: "context", content: ` ${a[i]}` });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) diff.push({ type: "remove", content: `-${a[i++]}` });
    else diff.push({ type: "add", content: `+${b[j++]}` });
  }
  while (i < a.length) diff.push({ type: "remove", content: `-${a[i++]}` });
  while (j < b.length) diff.push({ type: "add", content: `+${b[j++]}` });
  for (let index = 0; index < diff.length - 1; index++) {
    const current = diff[index]!;
    const next = diff[index + 1]!;
    if (current.type === "remove" && next.type === "add") {
      const { oldSegments, newSegments } = wordDiff(current.content.slice(1), next.content.slice(1));
      current.segments = oldSegments;
      next.segments = newSegments;
    }
  }
  return diff;
}

export function parseUnifiedDiff(text?: string): DiffLine[] {
  const diff: DiffLine[] = [];
  for (const line of splitLines(text ?? "")) {
    if (!line.length) diff.push({ type: "context", content: line });
    else if (line.startsWith("@@")) diff.push({ type: "header", content: line });
    else if (line.startsWith("+")) {
      if (!line.startsWith("+++")) diff.push({ type: "add", content: line });
    } else if (line.startsWith("-")) {
      if (!line.startsWith("---")) diff.push({ type: "remove", content: line });
    } else if (line.startsWith("diff --git") || line.startsWith("index ")) continue;
    else if (line.startsWith("\\ No newline")) diff.push({ type: "header", content: line });
    else diff.push({ type: "context", content: line });
  }
  return diff;
}
