/* eslint-disable import/no-extraneous-dependencies */
// Plugin-level test: drives the real V2 `setup()` through a fake context and a
// local HTTP sink, so the event wiring that decides *when* a turn is submitted
// is covered. The tracer is constructed inside `setup()` (it resolves its own
// config), so the endpoint is redirected with the plugin's own env override.
import { it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../src/v2.js";

type FakeContext = Parameters<typeof setup>[0];

const USER_ID = "msg_plugin_user";
const ASSISTANT_ID = "msg_plugin_assistant";
const SESSION_ID = "ses_plugin";

const sessionCreated = {
  type: "session.created",
  data: { sessionID: SESSION_ID, parentID: undefined },
};

const executionSucceeded = {
  type: "session.execution.succeeded",
  data: { sessionID: SESSION_ID },
};

const messages = [
  {
    type: "user",
    id: USER_ID,
    time: { created: 1_000 },
    text: "hello from the plugin test",
  },
  {
    type: "assistant",
    id: ASSISTANT_ID,
    time: { created: 2_000, completed: 2_500 },
    agent: "build",
    model: { id: "test-model", providerID: "test" },
    content: [{ type: "text", text: "hello back" }],
    finish: "stop",
  },
  { type: "idle", id: "msg_plugin_idle", time: { created: 3_000 } },
];

const makeContext = (events: unknown[]) => {
  const calls = { context: 0, get: 0, hook: 0 };

  const subscribe = async function* (options?: { signal?: AbortSignal }) {
    for (const event of events) {
      if (options?.signal?.aborted) return;
      yield event as never;
    }
    // Keep the stream open, like a live server, until cleanup aborts it.
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  const ctx = {
    app: { name: "opencode", version: "2.1.0", channel: "test" },
    location: { directory: tmpdir() },
    options: {},
    session: {
      get: async () => {
        calls.get += 1;
        return { id: SESSION_ID, location: { directory: tmpdir() } };
      },
      context: async () => {
        calls.context += 1;
        return messages;
      },
      hook: async () => {
        calls.hook += 1;
        return { dispose: async () => {} };
      },
    },
    event: { subscribe },
  };

  return { ctx: ctx as unknown as FakeContext, calls };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};

let server: Server | undefined;
let bodies: string[] = [];
let baseUrl = "";
const saved = { HOME: process.env.HOME, TRACE: process.env.TRACE_TO_LANGSMITH };

beforeEach(async () => {
  bodies = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST") bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  // Isolate config resolution from the developer's real langsmith.json.
  process.env.HOME = mkdtempSync(join(tmpdir(), "ls-opencode-test-"));
  process.env.TRACE_TO_LANGSMITH = "true";
  process.env.LANGSMITH_OPENCODE_ENDPOINT = baseUrl;
  process.env.LANGSMITH_OPENCODE_API_KEY = "test-key";
  process.env.LANGSMITH_OPENCODE_PROJECT = "plugin-test";
});

afterEach(async () => {
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.TRACE === undefined) delete process.env.TRACE_TO_LANGSMITH;
  else process.env.TRACE_TO_LANGSMITH = saved.TRACE;
  delete process.env.LANGSMITH_OPENCODE_ENDPOINT;
  delete process.env.LANGSMITH_OPENCODE_API_KEY;
  delete process.env.LANGSMITH_OPENCODE_PROJECT;

  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = undefined;
});

it("submits a turn when OpenCode 2 reports the execution finished", async () => {
  const { ctx, calls } = makeContext([sessionCreated, executionSucceeded]);
  const cleanup = await setup(ctx);

  const uploaded = await waitFor(() => bodies.length > 0);

  expect(uploaded).toBe(true);
  const payload = bodies.join("\n");
  expect(payload).toContain("opencode.session");
  expect(payload).toContain("opencode.assistant.turn");
  expect(payload).toContain("hello back");
  expect(payload).toContain("coding-agent-v1");
  expect(calls.context).toBeGreaterThan(0);

  await cleanup?.();
});

it("ignores events that do not finish a turn", async () => {
  const { ctx, calls } = makeContext([
    sessionCreated,
    { type: "session.step.started", data: { sessionID: SESSION_ID } },
    { type: "session.text.delta", data: { sessionID: SESSION_ID, delta: "he" } },
    { type: "session.step.ended", data: { sessionID: SESSION_ID } },
  ]);
  const cleanup = await setup(ctx);

  // Give the loop a chance to consume the scripted events.
  await new Promise((resolve) => setTimeout(resolve, 250));

  expect(calls.context).toBe(0);
  expect(bodies).toHaveLength(0);

  await cleanup?.();
});
