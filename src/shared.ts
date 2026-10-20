import { userInfo } from "node:os";
import { INTEGRATION_VERSION } from "./version.js";
import { getRepoInfo } from "./repo.js";

export const LS_AGENT_PURPOSE = "coding";
export type LSAgentType = "root" | "subagent" | "middleware" | "compaction";

/**
 * Session metadata the coding-agent-v1 block needs. Both the V1 and V2 tracers
 * feed this from their own session state, so the emitted contract stays
 * identical across OpenCode versions.
 */
export type CodingAgentSession = {
  runtimeVersion?: string | undefined;
  directory?: string | undefined;
};

/** Shared coding-agent-v1 block; createChild propagates it. Unknown values omitted, never null (leak rule). */
export const buildCodingAgentMetadata = (params: {
  agentType: LSAgentType;
  session: CodingAgentSession;
  threadId: string;
  turnId: string | undefined;
  turnNumber: number;
}): Record<string, unknown> => {
  const { agentType, session, threadId, turnId, turnNumber } = params;
  const cwd = session.directory ?? process.cwd();

  const metadata: Record<string, unknown> = {
    // Identity & grouping — required on every run.
    ls_agent_purpose: LS_AGENT_PURPOSE,
    ls_agent_type: agentType,
    ls_integration: "opencode",
    ls_agent_runtime: "OpenCode",
    thread_id: threadId,
    ls_trace_schema_version: "coding-agent-v1",

    // Versions & turn.
    ls_integration_version: INTEGRATION_VERSION,
    turn_number: turnNumber,
    cwd,
  };

  if (session.runtimeVersion) metadata.ls_agent_runtime_version = session.runtimeVersion;
  if (turnId) metadata.turn_id = turnId;

  // Git & workspace — emit only where the repo is resolvable.
  const repo = getRepoInfo(cwd);
  for (const [key, value] of Object.entries(repo)) {
    if (value != null) metadata[key] = value;
  }

  // local_username is PII-sensitive but the only stable handle available here;
  // user_id/user_email/sandbox_type/approval_policy are unknown, so omitted.
  const username = (() => {
    try {
      return userInfo().username || undefined;
    } catch {
      return undefined;
    }
  })();
  if (username) metadata.local_username = username;

  return metadata;
};
