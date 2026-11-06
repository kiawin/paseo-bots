import { describe, expect, it } from "vitest";
import { promptSections } from "../shared/bot";
import { parseTriggers, playbookRunbook, runbookDescription } from "../shared/playbooks";
import { makeBot } from "./helpers";

describe("runbooks", () => {
  it("turns a playbook into a runbook file that says when to use it", () => {
    const text = playbookRunbook({ name: "Month-end  close", triggers: ["month end", "close the books"], instructions: "1. Reconcile.\n" });
    expect(text).toBe("---\nname: Month-end close\ndescription: Use when the job mentions month end, close the books.\n---\n\n1. Reconcile.\n");
    expect(runbookDescription(text)).toBe("Use when the job mentions month end, close the books.");
    expect(runbookDescription("# Weekly report\n\nSteps")).toBe("Weekly report");
  });

  it("reads trigger lists", () => {
    expect(parseTriggers("invoice, receipt\nexpense report, invoice,")).toEqual(["invoice", "receipt", "expense report"]);
  });

  it("lists the runbooks folder in the prompt", () => {
    const context = { memory: "", memoryPath: null, recentWork: [], skills: [], paseoTools: false, botTools: false, apps: [] };
    const runbooks = [{ file: "invoices.md", description: "Use when paying invoices.", path: "/b/runbooks/invoices.md" }];
    const section = promptSections(makeBot(), { ...context, runbooksPath: "/b/runbooks", runbooks }).find((entry) => entry.title === "Runbooks");
    expect(section?.text).toContain('- invoices: Use when paying invoices. Read "/b/runbooks/invoices.md" before using it.');
    expect(promptSections(makeBot(), { ...context, runbooksPath: "/b/runbooks", runbooks: [] }).find((entry) => entry.title === "Runbooks")?.text).toContain("no runbooks yet");
    expect(promptSections(makeBot(), { ...context, runbooksPath: null, runbooks: [] }).map((entry) => entry.title)).toEqual(["Persona"]);
  });
});
