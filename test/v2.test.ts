import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { it, expect, vi } from "vitest";
import plugin from "../src/index.js";
import type { V2Event } from "../src/models.js";
import {
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
    expect(hook).toHaveBeenCalledWith("context", expect.any(Function));
    await expect(contextHook({ sessionID: "ses_broken" })).resolves.toBeUndefined();
    await cleanup?.();
    expect(dispose).toHaveBeenCalledOnce();
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
