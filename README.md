# @langchain/langsmith-opencode

Trace [OpenCode](https://opencode.ai/) sessions to [LangSmith](https://smith.langchain.com) so you can inspect agent turns, tool calls, model metadata, token usage, and subagent activity within LangSmith.

## What It Does

`@langchain/langsmith-opencode` is an OpenCode plugin that listens to OpenCode chat and event hooks, aggregates each user turn, and posts it to LangSmith as a run tree:

- `opencode.session` root runs for each completed user turn.
- `opencode.assistant.turn` child runs for assistant/model responses.
- Tool calls as nested `tool` runs with inputs, outputs, errors, timing, and attachments when available.
- Subagent sessions as nested traces under the parent tool call.
- LangSmith metadata for model name, provider, invocation parameters, token usage, and thread/session ID.

## Quick Start

Add the plugin to your OpenCode configuration file. You can configure it locally in `opencode.json` or globally in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@langchain/langsmith-opencode"]
}
```

Set your LangSmith credentials before starting OpenCode:

```shell
export LANGSMITH_API_KEY="lsv2_pt_..."
export TRACE_TO_LANGSMITH="true"
```

Then run OpenCode as usual. Completed turns will appear in the configured LangSmith project.

### LangSmith API keys

To create an API key:

1. Go to [smith.langchain.com](https://smith.langchain.com).
2. Sign in or create an account.
3. Open **Settings** -> **API Keys**.
4. Click **Create API Key**.
5. Copy the key and set it as `LANGSMITH_API_KEY`, `LANGSMITH_OPENCODE_API_KEY`, or `api_key` in a local config file.

## Configuration

Tracing is disabled by default. Enable it with `TRACE_TO_LANGSMITH=true` or with a config file.

### Environment Variables

The plugin accepts OpenCode-specific LangSmith variables first, then falls back to the generic LangSmith SDK variables when available:

| Variable                            | Required | Default               | Description                                                                                                   |
| ----------------------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `TRACE_TO_LANGSMITH`                | Yes      | `false`               | Set to `"true"` to enable tracing.                                                                            |
| `LANGSMITH_OPENCODE_API_KEY`        | No\*     | -                     | LangSmith API key. Falls back to `LANGSMITH_API_KEY`. Required unless every replica provides its own API key. |
| `LANGSMITH_OPENCODE_ENDPOINT`       | No       | LangSmith SDK default | LangSmith API URL. Falls back to `LANGSMITH_ENDPOINT`.                                                        |
| `LANGSMITH_OPENCODE_PROJECT`        | No       | `opencode`            | LangSmith project name. Falls back to `LANGSMITH_PROJECT`.                                                    |
| `LANGSMITH_OPENCODE_METADATA`       | No       | -                     | JSON object merged into root trace metadata.                                                                  |
| `LANGSMITH_OPENCODE_RUNS_ENDPOINTS` | No       | -                     | JSON array of replica destinations.                                                                           |
| `LANGSMITH_OPENCODE_REDACT`         | No       | `true`                | Redact detected secrets before upload. Set to `false` or `0` to disable.                                      |
| `LANGSMITH_OPENCODE_REDACT_EXTRA`   | No       | -                     | JSON array of extra `{ pattern, replace }` redaction rules. `pattern` is a case-sensitive regex.              |

Example:

```shell
export TRACE_TO_LANGSMITH="true"
export LANGSMITH_API_KEY="lsv2_pt_..."
export LANGSMITH_PROJECT="opencode"
export LANGSMITH_OPENCODE_METADATA='{"team":"agents","environment":"dev"}'
```

### Config Files

Use `.opencode/langsmith.json` in your project for per-project settings, or `~/.config/opencode/langsmith.json` for global defaults.

| Field                | Required | Default               | Description                                                                                 |
| -------------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `enabled`            | Yes      | `false`               | Set to `true` to enable tracing from the config file.                                       |
| `api_key`            | No\*     | -                     | LangSmith API key. Required unless provided by environment variable or replicas.            |
| `api_url`            | No       | LangSmith SDK default | LangSmith API URL, usually `https://api.smith.langchain.com`.                               |
| `project`            | No       | `opencode`            | LangSmith project name.                                                                     |
| `metadata`           | No       | -                     | Object merged into root trace metadata.                                                     |
| `replicas`           | No       | -                     | Array of additional LangSmith destinations to replicate traces to.                          |
| `redact`             | No       | `true`                | Redact detected secrets before upload. Set to `false` to disable.                           |
| `redact_extra_rules` | No       | -                     | Array of extra `{ pattern, replace }` redaction rules. `pattern` is a case-sensitive regex. |

```json
{
  "enabled": true,
  "api_key": "lsv2_pt_...",
  "api_url": "https://api.smith.langchain.com",
  "project": "opencode",
  "metadata": {
    "team": "agents",
    "environment": "dev"
  },
  "replicas": [
    {
      "api_url": "https://api.smith.langchain.com",
      "api_key": "lsv2_pt_...",
      "project": "opencode-replica",
      "updates": {
        "metadata": {
          "replica": true
        }
      }
    }
  ]
}
```

`api_key` is required unless the API key is provided by environment variable. Keep config files with API keys out of version control.

Replica objects support both snake_case and LangSmith SDK-style camelCase field names. Snake_case is recommended in config files.

| Field                     | Required | Description                                                                 |
| ------------------------- | -------- | --------------------------------------------------------------------------- |
| `api_url` / `apiUrl`      | No       | LangSmith API URL for the replica destination.                              |
| `api_key` / `apiKey`      | No       | API key for the destination workspace.                                      |
| `project` / `projectName` | No       | Project name in the destination workspace.                                  |
| `updates`                 | No       | Optional run fields to override on replicated runs, such as extra metadata. |

## What Gets Traced

The plugin captures OpenCode session events and converts them into LangSmith-compatible chat messages and run metadata.

Captured content includes:

- User messages, assistant messages, reasoning blocks, and file parts.
- Tool calls, tool results, tool errors, and tool attachments.
- System prompts associated with assistant turns.
- Model and provider metadata from OpenCode.
- Token usage from completed model steps when OpenCode provides it.
- Session history so each assistant turn has the relevant chat context.

Trace completion is based on OpenCode `step-finish` events. When OpenCode disposes the server instance, the plugin flushes pending LangSmith trace batches.

## Trace Metadata Contract (`coding-agent-v1`)

Every run sets a shared, versioned coding-agent metadata block on `run.extra.metadata`, so traces from any LangSmith coding-agent integration are identifiable, groupable, queryable, and attributable with the same stable keys. The block is built once on the root and propagates to child runs (langsmith ≥ 0.6.0 `createChild`).

**Required on every run:**

| Key                       | Value (this integration)                             |
| ------------------------- | ---------------------------------------------------- |
| `ls_agent_kind`           | `"coding_agent"` (fixed)                             |
| `ls_integration`          | `"opencode"` (fixed)                                 |
| `ls_agent_runtime`        | `"OpenCode"` (fixed)                                 |
| `thread_id`               | root session id (sub-sessions inherit the root's id) |
| `ls_trace_schema_version` | `"coding-agent-v1"` (fixed)                          |

**Required where the runtime exposes them:**

| Key                                                          | Source                                               |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| `ls_integration_version`                                     | this plugin's `package.json` version                 |
| `ls_agent_runtime_version`                                   | OpenCode version from the session info               |
| `turn_id`                                                    | the turn's user message id                           |
| `turn_number`                                                | 1-based index of the user turn within the session    |
| `repository_url` / `repository_provider` / `repository_name` | parsed from the git `origin` remote in `cwd`         |
| `git_branch` / `git_commit_sha`                              | git CLI, run in `cwd`                                |
| `cwd`                                                        | session working directory (`process.cwd()` fallback) |

**Contextual (emitted only where known):**

| Key                | Notes                                                            |
| ------------------ | ---------------------------------------------------------------- |
| `local_username`   | OS username (PII-sensitive)                                      |
| `ls_subagent_id`   | sub-session id — **subagent runs only**                          |
| `ls_subagent_type` | sub-session agent name (e.g. `general`) — **subagent runs only** |

Notes:

- Unknown values are **omitted, never set to `null`** — a present-but-null key counts as a contract leak.
- Scope-restricted keys do not propagate to runs they don't apply to. `ls_subagent_*` is stamped only on the sub-session (subagent) root after its children are created, so it never reaches the subagent's own `llm`/`tool` runs.
- **Subagent grouping:** a subagent sub-session always carries the **root** session's `thread_id`, never its own session id, so it groups with the parent thread.
- `approval_policy`, `user_id`, `user_email`, and `sandbox_type` are **omitted** — OpenCode's post-hoc session reconstruction exposes no per-run seam for a single approval-policy value, and no stable pseudonymous user/sandbox identifier.
- `ls_tool_name` is emitted only when a tool run's `name` differs from the native tool name; OpenCode names tool runs with the native name, so it is normally omitted.
- Existing model-run conventions (`ls_provider`, `ls_model_name`, `ls_invocation_params`, `usage_metadata`) are preserved unchanged.

## Troubleshooting

If traces do not appear in LangSmith:

- Confirm tracing is enabled with `TRACE_TO_LANGSMITH=true` or `"enabled": true` in config.
- Confirm an API key is set in the same shell, project config, or global config used by OpenCode.
- Confirm the plugin package is installed where OpenCode can resolve it.
- Check the project selected in LangSmith. If no project is configured, traces go to `opencode`.
- Restart OpenCode after changing `opencode.json`, `langsmith.json`, or environment variables.
- Make sure a user turn completes; incomplete turns are not submitted as complete traces.
