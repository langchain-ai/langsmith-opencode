/* eslint-disable import/no-extraneous-dependencies */
// Contract test for coding-agent-v1: runs the tracer over a captured session,
// validating each run against validator.json like the harness.
import { OpenCodeSessionTracer } from "../src/tracer.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it, expect, describe, beforeAll } from "vitest";
import { mockClient } from "./utils/mock_client.ts";
import { getAssumedTreeFromCalls } from "./utils/tree.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INTEGRATION_ID = "opencode";
const RUNTIME_NAME = "OpenCode";

type KeySpec = {
  key: string;
  appliesTo: string[];
  type: string;
  allowedValues: string[] | null;
  requirement: "always" | "where_known" | "contextual";
  requiredWhereKnown?: boolean;
};
type Contract = {
  keys: KeySpec[];
  integrations: string[];
  preserveExistingOnModelAndToolRuns: string[];
};

async function loadContract(): Promise<Contract> {
  const raw = await fs.readFile(path.join(__dirname, "fixtures", "validator.json"), "utf8");
  return JSON.parse(raw);
}

async function buildTree() {
  const { client, callSpy } = mockClient();
  const data = await fs.readFile(path.join(__dirname, "snapshot", "ses_subagents.jsonl"), "utf8");
  const lines = data
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const tracer = new OpenCodeSessionTracer(
    { enabled: true },
    { client, name: "opencode.session.subagents" },
  );
  for (const [method, ...payload] of lines) {
    if (method === "event") await tracer.handleEvent(payload[0]);
    if (method === "experimental.chat.system.transform") {
      await tracer.handleSystem(payload[0], payload[1]);
    }
  }
  return getAssumedTreeFromCalls(callSpy.mock.calls, client);
}

// Mirrors validate-thread.mjs opencode profile: structural only, never reads the
// contract metadata under test (that would be circular).
function classify(run: {
  run_type?: string;
  parent_run_id?: string | null;
  error?: unknown;
}): string {
  if (run.run_type === "llm") return "llm";
  if (run.run_type === "tool") return "tool";
  if (run.parent_run_id) return "subagent";
  return run.error ? "interrupted" : "root";
}

function typeOk(value: unknown, type: string): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  return true;
}

// Port of validate-thread.mjs validateRun (hard errors only).
function validateRun(contract: Contract, md: Record<string, unknown>, runType: string): string[] {
  const errors: string[] = [];

  if (md.ls_integration != null && md.ls_integration !== INTEGRATION_ID) {
    errors.push(`ls_integration "${md.ls_integration}" != "${INTEGRATION_ID}"`);
  }

  for (const spec of contract.keys) {
    if (!spec.appliesTo.includes(runType)) continue;
    const present = Object.prototype.hasOwnProperty.call(md, spec.key);
    if (!present) {
      if (spec.requirement === "always") errors.push(`missing required key "${spec.key}"`);
      continue;
    }
    const value = md[spec.key];
    if (!typeOk(value, spec.type)) {
      errors.push(`key "${spec.key}" expected ${spec.type}, got ${JSON.stringify(value)}`);
    }
    if (spec.allowedValues && !spec.allowedValues.includes(value as string)) {
      errors.push(`key "${spec.key}" value ${JSON.stringify(value)} not allowed`);
    }
  }

  // Leak rule: a contract key present on a runType outside its appliesTo.
  for (const spec of contract.keys) {
    if (spec.appliesTo.includes(runType)) continue;
    if (Object.prototype.hasOwnProperty.call(md, spec.key)) {
      errors.push(`key "${spec.key}" leaked onto runType "${runType}"`);
    }
  }

  // At least one turn marker (opencode exposes turns).
  if (md.turn_id == null && md.turn_number == null) {
    errors.push('neither "turn_id" nor "turn_number" present');
  }

  return errors;
}

describe("coding-agent-v1 contract", () => {
  let contract: Contract;
  let tree: Awaited<ReturnType<typeof buildTree>>;
  let runs: Array<{ key: string; runType: string; md: Record<string, unknown> }>;

  beforeAll(async () => {
    contract = await loadContract();
    tree = await buildTree();
    runs = Object.entries(tree.data).map(([key, run]) => ({
      key,
      runType: classify(run as never),
      md: ((run as { extra?: { metadata?: Record<string, unknown> } }).extra?.metadata ??
        {}) as Record<string, unknown>,
    }));
  });

  it("opencode is a registered integration in the contract", () => {
    expect(contract.integrations).toContain(INTEGRATION_ID);
  });

  it("produces all four run types from the subagent session", () => {
    const types = new Set(runs.map((r) => r.runType));
    expect(types).toContain("root");
    expect(types).toContain("llm");
    expect(types).toContain("tool");
    expect(types).toContain("subagent");
  });

  it("every run satisfies the contract (required keys, types, allowedValues, no leaks)", () => {
    const failures = runs
      .map((r) => ({ r, errors: validateRun(contract, r.md, r.runType) }))
      .filter(({ errors }) => errors.length > 0)
      .map(({ r, errors }) => `${r.key} [${r.runType}]: ${errors.join("; ")}`);
    expect(failures).toEqual([]);
  });

  it("root run carries the full identity + version + turn block", () => {
    const root = runs.find((r) => r.runType === "root");
    expect(root).toBeDefined();
    expect(root!.md).toMatchObject({
      ls_agent_kind: "coding_agent",
      ls_integration: INTEGRATION_ID,
      ls_agent_runtime: RUNTIME_NAME,
      ls_trace_schema_version: "coding-agent-v1",
      thread_id: expect.any(String),
      ls_integration_version: expect.any(String),
      turn_id: expect.any(String),
      turn_number: expect.any(Number),
      cwd: expect.any(String),
    });
    // approval_policy is omitted (not nulled) — see README.
    expect(Object.prototype.hasOwnProperty.call(root!.md, "approval_policy")).toBe(false);
    // never leak subagent identity onto the root.
    expect(root!.md.ls_subagent_id).toBeUndefined();
    expect(root!.md.ls_subagent_type).toBeUndefined();
  });

  it("subagent run carries ls_subagent_* and the ROOT thread_id (grouping)", () => {
    const root = runs.find((r) => r.runType === "root")!;
    const subagent = runs.find((r) => r.runType === "subagent");
    expect(subagent).toBeDefined();
    expect(subagent!.md.ls_subagent_id).toEqual(expect.any(String));
    expect(subagent!.md.ls_subagent_type).toBe("general");
    // Grouping rule: subagent groups under the parent/root thread, never its own.
    expect(subagent!.md.thread_id).toBe(root.md.thread_id);
    expect(subagent!.md.ls_subagent_id).not.toBe(subagent!.md.thread_id);
  });

  it("llm/tool runs inherit identity but never carry subagent identity", () => {
    for (const r of runs.filter((x) => x.runType === "llm" || x.runType === "tool")) {
      expect(r.md.ls_agent_kind).toBe("coding_agent");
      expect(r.md.ls_integration).toBe(INTEGRATION_ID);
      expect(r.md.thread_id).toEqual(expect.any(String));
      expect(Object.prototype.hasOwnProperty.call(r.md, "ls_subagent_id")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r.md, "ls_subagent_type")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r.md, "approval_policy")).toBe(false);
    }
  });

  it("llm runs preserve the existing model conventions", () => {
    for (const r of runs.filter((x) => x.runType === "llm")) {
      expect(r.md.ls_model_name).toEqual(expect.any(String));
      expect(r.md.ls_provider).toEqual(expect.any(String));
    }
  });
});
