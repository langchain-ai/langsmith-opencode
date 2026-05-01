import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export function getVar(suffix: string): string | undefined {
  return process.env[`LANGSMITH_OPENCODE_${suffix}`] ?? process.env[`LANGSMITH_${suffix}`];
}

const replicaSchema = z.preprocess(
  (value) => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    const replica = value as Record<string, unknown>;
    return {
      api_url: replica.api_url ?? replica.apiUrl,
      api_key: replica.api_key ?? replica.apiKey,
      project: replica.project ?? replica.projectName,
      updates: replica.updates,
    };
  },
  z.object({
    api_url: z.string().optional(),
    api_key: z.string().optional(),
    project: z.string().optional(),
    updates: z.record(z.string(), z.unknown()).optional(),
  }),
);

const configSchema = z.object({
  // TRACE_TO_LANGSMITH=true
  enabled: z.boolean(),

  // LANGSMITH_OPENCODE_API_KEY, falls back to LANGSMITH_API_KEY
  api_key: z.string().optional(),

  // LANGSMITH_OPENCODE_ENDPOINT, falls back to LANGSMITH_ENDPOINT
  api_url: z.string().optional(),

  // LANGSMITH_OPENCODE_PROJECT, falls back to LANGSMITH_PROJECT or 'opencode
  project: z.string().optional(),

  // LANGSMITH_OPENCODE_METADATA
  metadata: z.record(z.string(), z.unknown()).optional(),

  // LANGSMITH_OPENCODE_RUNS_ENDPOINTS
  replicas: z.array(replicaSchema).optional(),
});

const fileConfigSchema = configSchema.partial();

const tryParse = (value: string | undefined): unknown => {
  try {
    if (value == null) return undefined;
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const stripUndefined = <T extends Record<string, unknown>>(value: T): Partial<T> => {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
};

const getHomeDir = () => process.env.HOME ?? homedir();

const readConfigFile = async (filePath: string): Promise<Partial<Config>> => {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return fileConfigSchema.parse(JSON.parse(content));
  } catch (err) {
    return {};
  }
};

const getEnvConfig = (): Partial<Config> => {
  const enabled = process.env.TRACE_TO_LANGSMITH;

  return fileConfigSchema.parse(
    stripUndefined({
      api_key: getVar("API_KEY"),
      api_url: getVar("ENDPOINT"),
      project: getVar("PROJECT"),
      enabled: enabled == null ? undefined : enabled === "true",
      parent_dotted_order: getVar("PARENT_DOTTED_ORDER"),
      metadata: tryParse(getVar("METADATA")),
      replicas: tryParse(getVar("RUNS_ENDPOINTS")),
    }),
  );
};

export type Config = z.infer<typeof configSchema>;

export async function getConfig() {
  const home = getHomeDir();
  const [globalConfig, projectConfig] = await Promise.all([
    readConfigFile(join(home, ".config", "opencode", "langsmith.json")),
    readConfigFile(join(process.cwd(), ".opencode", "langsmith.json")),
  ]);
  const envConfig = getEnvConfig();

  return configSchema.parse({
    project: "opencode",
    enabled: false,
    ...globalConfig,
    ...projectConfig,
    ...envConfig,
  });
}
