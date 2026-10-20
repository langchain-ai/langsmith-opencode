/* eslint-disable import/no-extraneous-dependencies */
import { it, expect, describe } from "vitest";
import plugin, { LangSmithPlugin } from "../src/index.js";
import { OpenCodeSessionTracerV2 } from "../src/v2/tracer.js";
import type { V2Message } from "../src/v2/normalize.js";
import { mockClient } from "./utils/mock_client.ts";
import { getAssumedTreeFromCalls } from "./utils/tree.ts";

const sessionID = "ses_v2";
const userID = "msg_v2_user";
const assistantID = "msg_v2_assistant";
const idleID = "msg_v2_idle";

const tokens = { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } };

const user = (id: string, created: number, text: string, agent?: string): V2Message => ({
  type: "user",
  id,
  time: { created },
  text,
  ...(agent ? { agent } : {}),
});

const assistant = (
  id: string,
  created: number,
  content: Extract<V2Message, { type: "assistant" }>["content"],
  finish: string,
): V2Message => ({
  type: "assistant",
  id,
  time: { created, streamed: created + 100, completed: created + 100 },
  agent: "build",
  model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
  content,
  finish,
  tokens,
});

const idle = (created: number): V2Message => ({
  type: "idle",
  id: idleID,
  time: { created },
  outcome: "succeeded",
});

const runsNamed = (tree: Awaited<ReturnType<typeof getAssumedTreeFromCalls>>, name: string) =>
  Object.entries(tree.data)
    .filter(([key]) => key.startsWith(`${name}:`))
    .map(([, run]) => run);

describe("OpenCode 2 entrypoint", () => {
  it("exposes a v2 definition plus a v1 server entrypoint", () => {
    expect(plugin.id).toBe("langsmith");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
    expect(typeof LangSmithPlugin).toBe("function");
  });
});

it("v2 submits one turn from a session snapshot", async () => {
  const { client, callSpy } = mockClient();
  const tracer = new OpenCodeSessionTracerV2(
    { enabled: true },
    { client, name: "opencode.session" },
  );

  tracer.setSystemPrompt(sessionID, ["You are opencode, an interactive CLI tool"]);

  await tracer.handleSession({
    sessionID,
    runtimeVersion: "2.1.0",
    directory: "/tmp/langsmith-opencode-v2",
    messages: [
      user(userID, 1_000, "hello there"),
      assistant(assistantID, 2_000, [{ type: "text", text: "hi back" }], "stop"),
      idle(3_000),
    ],
  });

  const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);

  expect(tree.nodes).toHaveLength(2);
  expect(tree.data["opencode.session:0"]).toMatchObject({
    name: "opencode.session",
    run_type: "chain",
    extra: {
      metadata: {
        ls_agent_purpose: "coding",
        ls_agent_type: "root",
        ls_integration: "opencode",
        ls_agent_runtime: "OpenCode",
        ls_trace_schema_version: "coding-agent-v1",
        turn_id: userID,
        turn_number: 1,
        cwd: "/tmp/langsmith-opencode-v2",
        ls_agent_runtime_version: "2.1.0",
      },
    },
    inputs: {
      messages: [{ role: "user", content: [{ type: "text", text: "hello there" }] }],
    },
    outputs: {
      messages: [{ role: "assistant", content: [{ type: "text", text: "hi back" }] }],
    },
  });

  expect(tree.data["opencode.assistant.turn:1"]).toMatchObject({
    name: "opencode.assistant.turn",
    run_type: "llm",
    inputs: {
      messages: [
        { role: "system", content: "You are opencode, an interactive CLI tool" },
        { role: "user", content: [{ type: "text", text: "hello there" }] },
      ],
    },
    extra: {
      metadata: {
        ls_model_name: "claude-sonnet-4-5",
        ls_provider: "anthropic",
        ls_model_type: "chat",
        usage_metadata: {
          input_tokens: 10,
          output_tokens: 25,
          total_tokens: 35,
          input_token_details: { cache_read: 1, cache_creation: 2 },
        },
      },
    },
  });
});

it("v2 nests tool calls under the assistant turn", async () => {
  const { client, callSpy } = mockClient();
  const tracer = new OpenCodeSessionTracerV2(
    { enabled: true },
    { client, name: "opencode.session" },
  );

  await tracer.handleSession({
    sessionID,
    directory: "/tmp/langsmith-opencode-v2",
    messages: [
      user(userID, 1_000, "read the file"),
      assistant(
        assistantID,
        2_000,
        [
          { type: "text", text: "let me check" },
          {
            type: "tool",
            id: "tool_v2_read",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/a.ts" },
              content: [{ type: "text", text: "file contents" }],
              metadata: { truncated: false },
            },
            time: { created: 2_100, ran: 2_150, completed: 2_300 },
          },
        ],
        "tool-calls",
      ),
      idle(3_000),
    ],
  });

  const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);

  expect(tree.nodes).toHaveLength(3);
  expect(tree.data["read:2"]).toMatchObject({
    name: "read",
    run_type: "tool",
    inputs: { filePath: "/tmp/a.ts" },
    outputs: { output: "file contents" },
    extra: { metadata: { truncated: false } },
  });
  expect(tree.edges).toContainEqual(["opencode.assistant.turn:1", "read:2"]);
});

it("v2 records tool failures", async () => {
  const { client, callSpy } = mockClient();
  const tracer = new OpenCodeSessionTracerV2(
    { enabled: true },
    { client, name: "opencode.session" },
  );

  await tracer.handleSession({
    sessionID,
    messages: [
      user(userID, 1_000, "run it"),
      assistant(
        assistantID,
        2_000,
        [
          {
            type: "tool",
            id: "tool_v2_bash",
            name: "bash",
            state: {
              status: "error",
              input: { command: "false" },
              error: { type: "tool", message: "exit code 1" },
            },
            time: { created: 2_100, ran: 2_150, completed: 2_300 },
          },
        ],
        "tool-calls",
      ),
      idle(3_000),
    ],
  });

  const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);

  expect(tree.data["bash:2"]).toMatchObject({
    name: "bash",
    run_type: "tool",
    error: "exit code 1",
  });
});

it("v2 only submits a turn once", async () => {
  const { client, callSpy } = mockClient();
  const tracer = new OpenCodeSessionTracerV2(
    { enabled: true },
    { client, name: "opencode.session" },
  );

  const messages = [
    user(userID, 1_000, "hello there"),
    assistant(assistantID, 2_000, [{ type: "text", text: "hi back" }], "stop"),
    idle(3_000),
  ];

  await tracer.handleSession({ sessionID, messages });
  // Wait for the queued runs to reach the client before sampling call counts.
  await tracer.flush();
  const afterFirst = callSpy.mock.calls.length;

  // Snapshots are taken repeatedly while a session runs; completed turns must
  // not be resubmitted.
  await tracer.handleSession({ sessionID, messages });
  await tracer.handleSession({ sessionID, messages });
  await tracer.flush();

  expect(callSpy.mock.calls.length).toBe(afterFirst);

  const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
  expect(tree.nodes).toHaveLength(2);
});

it("v2 submits a turn that finished without an idle message", async () => {
  const { client, callSpy } = mockClient();
  const tracer = new OpenCodeSessionTracerV2(
    { enabled: true },
    { client, name: "opencode.session" },
  );

  // No `idle` message: the trailing turn is complete because the model stopped
  // without requesting another tool call.
  await tracer.handleSession({
    sessionID,
    messages: [
      user(userID, 1_000, "hello there"),
      assistant(assistantID, 2_000, [{ type: "text", text: "hi back" }], "stop"),
    ],
  });

  const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);

  expect(tree.nodes).toHaveLength(2);
  expect(tree.data["opencode.session:0"]).toMatchObject({ name: "opencode.session" });
});

it("v2 numbers turns and carries prior messages into the llm run", async () => {
  const { client, callSpy } = mockClient();
  const tracer = new OpenCodeSessionTracerV2(
    { enabled: true },
    { client, name: "opencode.session" },
  );

  await tracer.handleSession({
    sessionID,
    messages: [
      user("msg_v2_user_1", 1_000, "first"),
      assistant("msg_v2_assistant_1", 2_000, [{ type: "text", text: "first reply" }], "stop"),
      idle(3_000),
      user("msg_v2_user_2", 4_000, "second"),
      assistant("msg_v2_assistant_2", 5_000, [{ type: "text", text: "second reply" }], "stop"),
      { type: "idle", id: "msg_v2_idle_2", time: { created: 6_000 }, outcome: "succeeded" },
    ],
  });

  const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);

  const roots = runsNamed(tree, "opencode.session");
  expect(roots).toHaveLength(2);
  expect(
    roots.map((run) => (run.extra?.metadata as Record<string, unknown>).turn_number).sort(),
  ).toEqual([1, 2]);

  const secondTurn = roots.find(
    (run) => (run.extra?.metadata as Record<string, unknown>).turn_id === "msg_v2_user_2",
  );

  expect(secondTurn?.inputs).toMatchObject({
    messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
  });

  const llmRuns = runsNamed(tree, "opencode.assistant.turn");
  const secondLlm = llmRuns.find(
    (run) => run.outputs != null && JSON.stringify(run.outputs).includes("second reply"),
  );

  expect((secondLlm?.inputs as { messages: unknown[] }).messages).toEqual([
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "first reply" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ]);
});

it("v2 nests a sub-session under the tool call that spawned it", async () => {
  const { client, callSpy } = mockClient();
  const childSessionID = "ses_v2_child";

  let tracer: OpenCodeSessionTracerV2;

  tracer = new OpenCodeSessionTracerV2(
    { enabled: true },
    { client, name: "opencode.session" },
    {
      resolveSubgraph: async ({ sessionID: resolved, child, rootThreadId }) => {
        if (resolved !== childSessionID) return false;

        await tracer.handleSession({
          sessionID: childSessionID,
          rootSessionID: rootThreadId,
          parentID: sessionID,
          runtimeVersion: "2.1.0",
          directory: "/tmp/langsmith-opencode-v2",
          parentRunTree: child,
          messages: [
            user("msg_v2_child_user", 2_200, "do the thing", "general"),
            assistant("msg_v2_child_assistant", 2_400, [{ type: "text", text: "done" }], "stop"),
            {
              type: "idle",
              id: "msg_v2_child_idle",
              time: { created: 2_500 },
              outcome: "succeeded",
            },
          ],
        });

        return true;
      },
    },
  );

  await tracer.handleSession({
    sessionID,
    runtimeVersion: "2.1.0",
    directory: "/tmp/langsmith-opencode-v2",
    messages: [
      user(userID, 1_000, "delegate this"),
      assistant(
        assistantID,
        2_000,
        [
          {
            type: "tool",
            id: "tool_v2_task",
            name: "task",
            state: {
              status: "completed",
              input: { description: "do the thing" },
              content: [{ type: "text", text: "done" }],
              metadata: { sessionId: childSessionID },
            },
            time: { created: 2_100, ran: 2_150, completed: 2_600 },
          },
        ],
        "tool-calls",
      ),
      idle(3_000),
    ],
  });

  const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);

  const sessionRuns = runsNamed(tree, "opencode.session");
  expect(sessionRuns).toHaveLength(2);

  const subagent = sessionRuns.find(
    (run) => (run.extra?.metadata as Record<string, unknown>).ls_agent_type === "subagent",
  );

  expect(subagent?.extra?.metadata).toMatchObject({
    ls_agent_type: "subagent",
    ls_subagent_id: childSessionID,
    ls_subagent_type: "general",
    // Sub-sessions carry the root session's thread id so traces group together.
    thread_id: sessionID,
  });

  // The tool run is replaced by the nested sub-session.
  expect(runsNamed(tree, "task")).toHaveLength(0);

  const subagentKey = Object.entries(tree.data).find(
    ([, run]) => (run.extra?.metadata as Record<string, unknown>)?.ls_agent_type === "subagent",
  )?.[0];

  expect(subagentKey).toBeDefined();
  expect(tree.edges).toContainEqual(["opencode.assistant.turn:1", subagentKey]);
});
