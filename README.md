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

Example:

```shell
export TRACE_TO_LANGSMITH="true"
export LANGSMITH_API_KEY="lsv2_pt_..."
export LANGSMITH_PROJECT="opencode"
export LANGSMITH_OPENCODE_METADATA='{"team":"agents","environment":"dev"}'
```

### Config Files

Use `.opencode/langsmith.json` in your project for per-project settings, or `~/.config/opencode/langsmith.json` for global defaults.

| Field      | Required | Default               | Description                                                                      |
| ---------- | -------- | --------------------- | -------------------------------------------------------------------------------- |
| `enabled`  | Yes      | `false`               | Set to `true` to enable tracing from the config file.                            |
| `api_key`  | No\*     | -                     | LangSmith API key. Required unless provided by environment variable or replicas. |
| `api_url`  | No       | LangSmith SDK default | LangSmith API URL, usually `https://api.smith.langchain.com`.                    |
| `project`  | No       | `opencode`            | LangSmith project name.                                                          |
| `metadata` | No       | -                     | Object merged into root trace metadata.                                          |
| `replicas` | No       | -                     | Array of additional LangSmith destinations to replicate traces to.               |

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

## Troubleshooting

If traces do not appear in LangSmith:

- Confirm tracing is enabled with `TRACE_TO_LANGSMITH=true` or `"enabled": true` in config.
- Confirm an API key is set in the same shell, project config, or global config used by OpenCode.
- Confirm the plugin package is installed where OpenCode can resolve it.
- Check the project selected in LangSmith. If no project is configured, traces go to `opencode`.
- Restart OpenCode after changing `opencode.json`, `langsmith.json`, or environment variables.
- Make sure a user turn completes; incomplete turns are not submitted as complete traces.
