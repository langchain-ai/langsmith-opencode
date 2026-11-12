import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { it, expect, vi } from "vitest";
import plugin from "../src/index.js";
import { startV2Tracing } from "../src/v2/translator.js";
import type { V2Event } from "../src/models.js";
import { EMPTY_TOKENS } from "../src/v2/constants.js";
import {
  MODEL,
  deliverMessage,
  executionEnded,
  newV2Translator,
  queueUserMessage,
  STOPPED,
  stepStarted,
  textStep,
  traceV2Events,
  traceV2Recording,
} from "./utils/v2_replay.ts";
import { loadJSONL } from "./utils/snapshot.ts";
import { getAssumedTreeFromCalls } from "./utils/tree.ts";

const ROOT_SESSION = "ses_e37676647ffeGMhcZ2UIVV7RUS";
const SUBAGENT_SESSION = "ses_e37675ecaffe56Osr8hJa9iih7";
const IMAGE_PROMPT = {
  data: "iVBOR",
  mime: "image/png",
  name: "a.png",
  source: { type: "inline" },
};
const IMAGE = { type: "file", uri: "data:image/png;base64,iVBOR", mime: "image/png" };

it("v2 editing traces each model call with its tools, tokens and system prompt", async () => {
  const tree = await traceV2Recording(await loadJSONL("v2_editing.jsonl"));
  expect(tree.edges).toEqual([
    ["opencode.session:0", "opencode.assistant.turn:1"],
    ["opencode.assistant.turn:1", "write:2"],
    ["opencode.session:0", "opencode.assistant.turn:3"],
    ["opencode.assistant.turn:3", "edit:4"],
    ["opencode.session:0", "opencode.assistant.turn:5"],
    ["opencode.assistant.turn:5", "read:6"],
    ["opencode.session:0", "opencode.assistant.turn:7"],
  ]);
  expect(tree.data["opencode.session:0"]).toMatchObject({
    inputs: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: expect.stringMatching(/^Create notes.txt/) }],
        },
      ],
    },
    extra: {
      metadata: {
        ls_agent_type: "root",
        ls_agent_runtime_version: "2.2.7",
        thread_id: "ses_e3767b15effemFdLb69iooj4fo",
        turn_number: 1,
        cwd: "/tmp/opencode/v2-editing",
      },
    },
  });
  expect(tree.data["opencode.assistant.turn:1"]).toMatchObject({
    inputs: {
      messages: [
        {
          role: "system",
          content: expect.stringContaining("You are an AI agent running in OpenCode"),
        },
        { role: "user" },
      ],
    },
    extra: {
      metadata: {
        ls_model_name: "claude-haiku-4-5",
        ls_provider: "anthropic",
        usage_metadata: {
          input_tokens: 3,
          output_tokens: 91,
          total_tokens: 94,
          input_token_details: { cache_read: 0, cache_creation: 10637 },
        },
      },
    },
  });
  expect(tree.data["write:2"]).toMatchObject({
    inputs: { path: "notes.txt", content: "apple\nbanana\ncherry" },
    outputs: { output: "Created file successfully: notes.txt" },
  });
});

it("v2 subagent session nests under the tool call that launched it", async () => {
  const tree = await traceV2Recording(await loadJSONL("v2_subagents.jsonl"));
  expect(tree.edges).toEqual([
    ["opencode.session:0", "opencode.assistant.turn:1"],
    ["opencode.assistant.turn:1", "opencode.session:2"],
    ["opencode.session:2", "opencode.assistant.turn:3"],
    ["opencode.assistant.turn:3", "read:4"],
    ["opencode.session:2", "opencode.assistant.turn:5"],
    ["opencode.session:0", "opencode.assistant.turn:6"],
  ]);
  expect(tree.data["opencode.session:2"]).toMatchObject({
    extra: {
      metadata: {
        ls_agent_type: "subagent",
        ls_subagent_type: "general",
        ls_subagent_id: SUBAGENT_SESSION,
        thread_id: ROOT_SESSION,
        turn_number: 1,
      },
    },
  });
});

it("v2 continued session counts earlier turns and carries them as history", async () => {
  const lines = await loadJSONL("v2_multiturn.jsonl");
  const secondProcess = lines.slice(lines.findLastIndex(([kind]) => kind === "setup"));
  const tree = await traceV2Recording(secondProcess);
  expect(tree.data["opencode.session:0"]).toMatchObject({
    extra: { metadata: { turn_number: 2 } },
  });
  expect(tree.data["opencode.assistant.turn:1"]).toMatchObject({
    inputs: {
      messages: [
        { role: "system" },
        { role: "user", content: [{ type: "text", text: expect.stringMatching(/^Create a.txt/) }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "write", input: { path: "a.txt", content: "hello" } },
          ],
        },
        { role: "tool", name: "write", content: "Created file successfully: a.txt" },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        {
          role: "user",
          content: [{ type: "text", text: "Read a.txt and tell me what it says." }],
        },
      ],
    },
  });
});

it("v2 setup does nothing on the partial context OpenCode v1 passes it", async () => {
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  const partialContext = { options: {}, agent: {}, plugin: {} };
  try {
    await expect(plugin.setup(partialContext as never)).resolves.toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("v2 uploads a turn's runs as soon as the turn finishes", async () => {
  const { tracer, translator } = newV2Translator();
  const flush = vi.spyOn(tracer, "flush").mockResolvedValue();

  await translator.handleEvent(executionEnded(ROOT_SESSION) as V2Event);
  expect(flush).toHaveBeenCalledOnce();
});

it("v2 traces attached images, reasoning, failed tool calls and tool attachments", async () => {
  const sessionID = "ses_reasoning";
  const step = { sessionID, assistantMessageID: "msg_assistant" };
  const failure = { type: "tool", message: "exit code 1" };
  const events = [
    queueUserMessage(sessionID, "msg_user", "Run the check", [IMAGE_PROMPT]),
    deliverMessage(sessionID, "msg_user"),
    stepStarted(sessionID, "msg_assistant"),
    { type: "session.reasoning.ended", data: { ...step, ordinal: 0, text: "I should run it" } },
    { type: "session.tool.input.started", data: { ...step, id: "call_1", name: "bash" } },
    { type: "session.tool.called", data: { ...step, id: "call_1", input: { command: "false" } } },
    { type: "session.tool.failed", data: { ...step, id: "call_1", error: failure } },
    { type: "session.tool.input.started", data: { ...step, id: "call_2", name: "read" } },
    { type: "session.tool.called", data: { ...step, id: "call_2", input: { path: "a.png" } } },
    { type: "session.tool.success", data: { ...step, id: "call_2", content: [IMAGE] } },
    { type: "session.step.ended", data: { ...step, ...STOPPED } },
    executionEnded(sessionID),
  ];
  const tree = await traceV2Events(events);
  expect(tree.data["opencode.session:0"]).toMatchObject({
    inputs: {
      messages: [{ content: [{ type: "text" }, { type: "file", id: "a.png", url: IMAGE.uri }] }],
    },
  });
  expect(tree.data["opencode.assistant.turn:1"]).toMatchObject({
    outputs: {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should run it" },
            { type: "tool_use", name: "bash", input: { command: "false" } },
            { type: "tool_use", name: "read", input: { path: "a.png" } },
          ],
        },
        { role: "tool", name: "bash", content: "exit code 1" },
        { role: "tool", name: "read" },
      ],
    },
  });
  expect(tree.data["bash:2"]).toMatchObject({ error: "exit code 1" });
  expect(tree.data["read:3"]).toMatchObject({
    outputs: { attachments: [{ type: "file", url: IMAGE.uri, mime_type: "image/png" }] },
  });
});

it("v2 setup reads project settings, keeps tracing errors out of the model request and cleans up", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langsmith-opencode-"));
  const settingsFolder = path.join(directory, ".opencode");
  const settingsFile = path.join(settingsFolder, "langsmith.json");
  await fs.mkdir(settingsFolder);
  await fs.writeFile(settingsFile, JSON.stringify({ enabled: true }));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("TRACE_TO_LANGSMITH", undefined);
  const subscribe = vi.fn(async function* () {});
  const dispose = vi.fn(async () => undefined);
  let contextHook: (request: unknown) => Promise<void> = async () => undefined;
  const hook = vi.fn(async (_name: string, callback: typeof contextHook) => {
    contextHook = callback;
    return { dispose };
  });
  const context = {
    app: { version: "2.2.7" },
    location: { directory },
    session: { hook },
    event: { subscribe },
  };

  try {
    const cleanup = await plugin.setup(context as never);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(hook.mock.calls.map(([name]) => name)).toEqual(["context", "compaction"]);
    await expect(contextHook({ sessionID: "ses_broken" })).resolves.toBeUndefined();
    await cleanup?.();
    expect(dispose).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllEnvs();
    await fs.unlink(settingsFile);
    await fs.rmdir(settingsFolder);
    await fs.rmdir(directory);
  }
});

it("v2 message queued during a turn starts its own turn once delivered", async () => {
  const sessionID = "ses_queued";
  const tree = await traceV2Events([
    queueUserMessage(sessionID, "msg_1", "first"),
    deliverMessage(sessionID, "msg_1"),
    queueUserMessage(sessionID, "msg_2", "second"),
    ...textStep(sessionID, "msg_a1", "answer one"),
    deliverMessage(sessionID, "msg_2"),
    ...textStep(sessionID, "msg_a2", "answer two"),
    executionEnded(sessionID),
  ]);
  const turns = Object.values(tree.data).filter((run) => run.name === "opencode.session");
  const firstText = (messages: { content: { text: string }[] }[]) => messages[0].content[0].text;
  expect(
    turns.map((run) => [firstText(run.inputs.messages), firstText(run.outputs!.messages)]),
  ).toEqual([
    ["first", "answer one"],
    ["second", "answer two"],
  ]);
});

it("v2 compaction traces as its own turn with its prompt, summary and tokens", async () => {
  const sessionID = "ses_compact";
  const tokens = { ...EMPTY_TOKENS, input: 900, output: 40 };
  const ended = { sessionID, reason: "manual", model: MODEL, text: "Summary", tokens };
  const event = (data: unknown) => ["event", data] as [string, unknown];
  const tree = await traceV2Recording([
    ["setup", { directory: "/tmp/opencode", version: "2.2.7" }],
    event(queueUserMessage(sessionID, "msg_u", "Hello")),
    event(deliverMessage(sessionID, "msg_u")),
    ...textStep(sessionID, "msg_a", "Hi").map(event),
    event(executionEnded(sessionID)),
    event({
      type: "session.inbox.enqueued",
      data: { sessionID, inboxID: "msg_c", item: { type: "compaction", payload: {} } },
    }),
    event(deliverMessage(sessionID, "msg_c")),
    [
      "session.hook.compaction",
      { sessionID, agent: "build", model: MODEL, system: [{ text: "Summarize" }], messages: [] },
    ],
    event({
      type: "session.compaction.started",
      created: 20,
      data: { sessionID, inputID: "msg_c", reason: "manual" },
    }),
    event({ type: "session.compaction.ended", created: 30, data: ended }),
    event(executionEnded(sessionID)),
  ]);
  expect(tree.data["opencode.session:2"]).toMatchObject({
    inputs: {
      messages: [
        {
          role: "user",
          content: [{ type: "compaction", data: { auto: false } }],
        },
      ],
    },
    outputs: { messages: [{ role: "assistant", content: [{ type: "text", text: "Summary" }] }] },
  });
  expect(tree.data["opencode.assistant.turn:3"]).toMatchObject({
    inputs: {
      messages: [
        { role: "system", content: "Summarize" },
        { role: "user", content: [{ text: "Hello" }] },
        { role: "assistant", content: [{ text: "Hi" }] },
        { role: "user", content: [{ type: "compaction" }] },
      ],
    },
    end_time: 30,
    extra: {
      metadata: {
        ls_model_name: "claude-haiku-4-5",
        usage_metadata: { input_tokens: 900, output_tokens: 40 },
      },
    },
  });
});

it("v2 automatic compaction mid-turn keeps the answers before and after it", async () => {
  const sessionID = "ses_auto_compact";
  const ended = { sessionID, reason: "auto", text: "Summary" };
  const tree = await traceV2Events([
    queueUserMessage(sessionID, "msg_u", "Do the big task"),
    deliverMessage(sessionID, "msg_u"),
    ...textStep(sessionID, "msg_a1", "Answer"),
    { type: "session.compaction.started", data: { sessionID, reason: "auto" } },
    { type: "session.compaction.ended", data: ended },
    { type: "session.compaction.started", data: { sessionID, reason: "auto" } },
    { type: "session.compaction.ended", data: { ...ended, text: "Summary two" } },
    ...textStep(sessionID, "msg_a2", "Done"),
    executionEnded(sessionID),
  ]);
  expect(tree.data["opencode.session:0"]).toMatchObject({
    start_time: expect.stringMatching(/^1970-01-01T00:00:00\.001/),
    inputs: {
      messages: [
        {
          content: [
            { type: "text", text: "Do the big task" },
            { type: "compaction", data: { auto: true } },
            { type: "compaction", data: { auto: true } },
          ],
        },
      ],
    },
  });
  const outputs = tree.data["opencode.session:0"].outputs?.messages;
  expect(
    outputs?.map((message: { content: { text: string }[] }) => message.content[0].text),
  ).toEqual(["Answer", "Summary", "Summary two", "Done"]);
});

it("v2 failed compaction still uploads its turn", async () => {
  const sessionID = "ses_compact_failed";
  const error = { type: "api", message: "context too large" };
  const tree = await traceV2Events([
    { type: "session.compaction.started", data: { sessionID, reason: "manual" } },
    { type: "session.compaction.failed", data: { sessionID, reason: "manual", error } },
    executionEnded(sessionID, "session.execution.failed"),
  ]);
  expect(tree.edges).toEqual([["opencode.session:0", "opencode.assistant.turn:1"]]);
});

it("v2 hidden reminder messages are not counted as earlier turns", async () => {
  const sessionID = "ses_plan";
  const reminder = {
    role: "user",
    content: [{ type: "text", text: "<system-reminder>Plan mode</system-reminder>" }],
  };
  const typed = { id: "msg_u", role: "user", content: [{ type: "text", text: "Plan it" }] };
  const tree = await traceV2Recording([
    ["setup", { directory: "/tmp/opencode", version: "2.2.7" }],
    ["event", queueUserMessage(sessionID, "msg_u", "Plan it")],
    ["event", deliverMessage(sessionID, "msg_u")],
    [
      "session.hook.context",
      { sessionID, agent: "plan", model: MODEL, system: [], messages: [reminder, typed] },
    ],
    ...textStep(sessionID, "msg_a", "").map((event) => ["event", event] as const),
    ["event", executionEnded(sessionID)],
  ]);
  expect(tree.data["opencode.assistant.turn:1"]).toMatchObject({
    inputs: { messages: [{ role: "system" }, { role: "user", content: [{ text: "Plan it" }] }] },
    extra: { metadata: { turn_number: 1 } },
  });
});

it("v2 background subagent that ends after the parent pauses nests once, and later steps stay", async () => {
  const [parent, child] = ["ses_parent", "ses_child"];
  const step = { sessionID: parent, assistantMessageID: "msg_a1" };
  const callSubagent = (assistantMessageID: string, id: string) => {
    const call = { sessionID: parent, assistantMessageID, id };
    return [
      { type: "session.tool.input.started", data: { ...call, name: "subagent" } },
      { type: "session.tool.called", data: { ...call, input: {} } },
      {
        type: "session.tool.success",
        data: { ...call, content: [], metadata: { sessionID: child } },
      },
    ];
  };
  const tree = await traceV2Events([
    queueUserMessage(parent, "msg_u", "Check a.txt in the background"),
    deliverMessage(parent, "msg_u"),
    { type: "session.step.started", data: { ...step, agent: "build", model: MODEL, started: 3 } },
    ...callSubagent("msg_a1", "call_1"),
    { type: "session.step.ended", data: { ...step, ...STOPPED } },
    { type: "session.created", data: { sessionID: child, parentID: parent, agent: "general" } },
    queueUserMessage(child, "msg_c", "Read a.txt"),
    deliverMessage(child, "msg_c"),
    ...textStep(child, "msg_c1", "alpha"),
    executionEnded(child),
    stepStarted(parent, "msg_a2"),
    ...callSubagent("msg_a2", "call_2"),
    {
      type: "session.step.ended",
      data: { sessionID: parent, assistantMessageID: "msg_a2", ...STOPPED },
    },
    executionEnded(parent),
  ]);
  expect(tree.data["opencode.assistant.turn:1"].end_time).toBe(7);
  expect(tree.edges).toEqual([
    ["opencode.session:0", "opencode.assistant.turn:1"],
    ["opencode.assistant.turn:1", "opencode.session:2"],
    ["opencode.session:2", "opencode.assistant.turn:3"],
    ["opencode.session:0", "opencode.assistant.turn:4"],
    ["opencode.assistant.turn:4", "subagent:5"],
  ]);
});

it("v2 interrupted turn is still traced with what it produced", async () => {
  const sessionID = "ses_interrupted";
  const step = { sessionID, assistantMessageID: "msg_a" };
  const tree = await traceV2Events([
    queueUserMessage(sessionID, "msg_u", "Run the long job"),
    deliverMessage(sessionID, "msg_u"),
    { type: "session.step.started", data: { ...step, agent: "build", model: MODEL, started: 3 } },
    { type: "session.text.ended", data: { ...step, ordinal: 0, text: "Starting" } },
    {
      type: "session.step.failed",
      data: { ...step, error: { type: "aborted", message: "Step interrupted" } },
    },
    executionEnded(sessionID, "session.execution.interrupted"),
  ]);
  expect(tree.data["opencode.session:0"]).toMatchObject({
    outputs: { messages: [{ role: "assistant", content: [{ type: "text", text: "Starting" }] }] },
  });
  expect(tree.data["opencode.assistant.turn:1"].end_time).toBe(5);
});

it("v2 shutdown uploads a turn whose run never finished", async () => {
  const { client, callSpy, tracer } = newV2Translator();
  const sessionID = "ses_quit";
  const events = [
    queueUserMessage(sessionID, "msg_u", "Hello"),
    deliverMessage(sessionID, "msg_u"),
    ...textStep(sessionID, "msg_a", "Hi"),
  ].map((event, index) => ({ ...event, created: index + 1 }));
  let drained = () => {};
  const allRead = new Promise<void>((resolve) => (drained = resolve));
  const context = {
    app: { version: "2.2.7" },
    location: { directory: "/tmp/opencode" },
    session: { hook: async () => ({ dispose: async () => undefined }) },
    event: {
      subscribe: async function* () {
        yield* events;
        drained();
      },
    },
  };
  const cleanup = await startV2Tracing(context as never, tracer);
  await allRead;
  await cleanup();
  const tree = await getAssumedTreeFromCalls(callSpy.mock.calls, client);
  expect(tree.edges).toEqual([["opencode.session:0", "opencode.assistant.turn:1"]]);
});
