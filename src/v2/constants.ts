export const V2_PLUGIN_ID = "langsmith-opencode";

export const EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

export const LOG_PREFIX = `[${V2_PLUGIN_ID}]`;

export const STOP_REASON = "stop";

export const CONTINUED_REASON = "continued";

export const AUTO_COMPACTION = "auto";

export const EMPTY_MODEL = { id: "", providerID: "" };
