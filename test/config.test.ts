/* eslint-disable import/no-extraneous-dependencies */
import { vol } from "memfs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, getVar } from "../src/config.js";

vi.mock("node:fs", async () => {
  const { fs } = await import("memfs");
  return fs;
});

vi.spyOn(process, "cwd").mockImplementation(() => "/workspace");

const writeConfig = (configPath: "project" | "global", config: Record<string, unknown>) => {
  const filePath =
    configPath === "project"
      ? "/workspace/.opencode/langsmith.json"
      : "/home/test/.config/opencode/langsmith.json";

  vol.fromJSON({ [filePath]: JSON.stringify(config) }, "/");
};

beforeEach(() => {
  vol.reset();
  vi.stubEnv("HOME", "/home/test");
});

afterEach(() => {
  vol.reset();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.mocked(process.cwd).mockRestore();
});

it("prefers OpenCode-specific variables over generic LangSmith variables", () => {
  vi.stubEnv("LANGSMITH_API_KEY", "generic-api-key");
  vi.stubEnv("LANGSMITH_OPENCODE_API_KEY", "opencode-api-key");

  expect(getVar("API_KEY")).toBe("opencode-api-key");
});

it("falls back to generic LangSmith variables", () => {
  vi.stubEnv("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com");

  expect(getVar("ENDPOINT")).toBe("https://api.smith.langchain.com");
});

it("returns default config when no environment variables are set", async () => {
  expect(await getConfig()).toEqual({
    api_key: undefined,
    api_url: undefined,
    project: "opencode",
    enabled: false,
    metadata: undefined,
    replicas: undefined,
    redact: true,
    redact_extra_rules: undefined,
  });
});

it("parses configured LangSmith values", async () => {
  vi.stubEnv("LANGSMITH_OPENCODE_API_KEY", "opencode-api-key");
  vi.stubEnv("LANGSMITH_OPENCODE_ENDPOINT", "https://example.com");
  vi.stubEnv("LANGSMITH_OPENCODE_PROJECT", "custom-project");
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  vi.stubEnv(
    "LANGSMITH_OPENCODE_METADATA",
    JSON.stringify({
      environment: "test",
      nested: { value: 1 },
    }),
  );
  vi.stubEnv(
    "LANGSMITH_OPENCODE_RUNS_ENDPOINTS",
    JSON.stringify([
      {
        apiUrl: "https://replica.example.com",
        apiKey: "replica-api-key",
        projectName: "replica-project",
        updates: { tags: ["opencode"] },
      },
    ]),
  );

  expect(await getConfig()).toEqual({
    api_key: "opencode-api-key",
    api_url: "https://example.com",
    project: "custom-project",
    enabled: true,
    metadata: {
      environment: "test",
      nested: { value: 1 },
    },
    replicas: [
      {
        api_url: "https://replica.example.com",
        api_key: "replica-api-key",
        project: "replica-project",
        updates: { tags: ["opencode"] },
      },
    ],
    redact: true,
    redact_extra_rules: undefined,
  });
});

it("loads global config from ~/.config/opencode/langsmith.json", async () => {
  writeConfig("global", {
    api_key: "global-api-key",
    api_url: "https://global.example.com",
    project: "global-project",
    enabled: true,
    metadata: { source: "global" },
    replicas: [
      {
        api_url: "https://global-replica.example.com",
        api_key: "global-replica-api-key",
        project: "global-replica-project",
        updates: { source: "global" },
      },
    ],
  });

  expect(await getConfig()).toEqual({
    api_key: "global-api-key",
    api_url: "https://global.example.com",
    project: "global-project",
    enabled: true,
    metadata: { source: "global" },
    replicas: [
      {
        api_url: "https://global-replica.example.com",
        api_key: "global-replica-api-key",
        project: "global-replica-project",
        updates: { source: "global" },
      },
    ],
    redact: true,
    redact_extra_rules: undefined,
  });
});

it("loads project config from process.cwd()/.opencode/langsmith.json", async () => {
  writeConfig("project", {
    api_key: "project-api-key",
    project: "project-project",
    enabled: true,
    metadata: { source: "project" },
  });

  expect(await getConfig()).toMatchObject({
    api_key: "project-api-key",
    project: "project-project",
    enabled: true,
    metadata: { source: "project" },
  });
});

it("prefers project config from process.cwd() over global config", async () => {
  writeConfig("global", {
    api_key: "global-api-key",
    project: "global-project",
    enabled: false,
    metadata: { source: "global" },
  });
  writeConfig("project", {
    api_key: "project-api-key",
    project: "project-project",
    enabled: true,
    metadata: { source: "project" },
  });

  expect(await getConfig()).toMatchObject({
    api_key: "project-api-key",
    project: "project-project",
    enabled: true,
    metadata: { source: "project" },
  });
});

it("prefers environment variables over project config", async () => {
  writeConfig("project", {
    api_key: "project-api-key",
    api_url: "https://project.example.com",
    project: "project-project",
    enabled: false,
    metadata: { source: "project" },
  });
  vi.stubEnv("LANGSMITH_OPENCODE_API_KEY", "env-api-key");
  vi.stubEnv("LANGSMITH_OPENCODE_PROJECT", "env-project");
  vi.stubEnv("TRACE_TO_LANGSMITH", "true");
  vi.stubEnv("LANGSMITH_OPENCODE_METADATA", JSON.stringify({ source: "env" }));

  expect(await getConfig()).toMatchObject({
    api_key: "env-api-key",
    api_url: "https://project.example.com",
    project: "env-project",
    enabled: true,
    metadata: { source: "env" },
  });
});

it("treats non-true enabled values as disabled", async () => {
  vi.stubEnv("TRACE_TO_LANGSMITH", "unknown");
  const config = await getConfig();
  expect(config.enabled).toBe(false);
});

it("ignores invalid JSON metadata and replicas", async () => {
  vi.stubEnv("LANGSMITH_OPENCODE_METADATA", "{invalid");
  vi.stubEnv("LANGSMITH_OPENCODE_RUNS_ENDPOINTS", "{invalid");

  const config = await getConfig();
  expect(config.metadata).toBeUndefined();
  expect(config.replicas).toBeUndefined();
});
