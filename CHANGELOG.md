# @langchain/langsmith-opencode

## 0.1.0

### Minor Changes

- [#7](https://github.com/langchain-ai/langsmith-opencode/pull/7) [`bfb2e91`](https://github.com/langchain-ai/langsmith-opencode/commit/bfb2e91c9c6a9de193ca242fe99614ca008d8746) Thanks [@harisaiharish](https://github.com/harisaiharish)! - Adopt the coding-agent-v1 trace metadata contract. Every run now carries standardized identity (`ls_agent_kind`, `ls_agent_runtime`, `ls_trace_schema_version`), version (`ls_integration_version`, `ls_agent_runtime_version`), turn (`turn_id`, `turn_number`), and repository/git/`cwd` keys, and `thread_id` now lands on every run so LLM/tool/subagent runs group correctly. Subagent sub-sessions are grouped under the parent thread with `ls_subagent_id`/`ls_subagent_type`. Renames `ls_integration` from `"opencode-js"` to `"opencode"` and drops the non-contract `ls_agent_type` key.

- [#8](https://github.com/langchain-ai/langsmith-opencode/pull/8) [`7ffee2e`](https://github.com/langchain-ai/langsmith-opencode/commit/7ffee2e366f59f1a0ca0c610cbd41bb34f4058e4) Thanks [@harisaiharish](https://github.com/harisaiharish)! - Redact secrets from traces before upload using the SDK's `createSecretAnonymizer()` preset, set on the tracing `Client`. On by default; opt out with `LANGSMITH_OPENCODE_REDACT=false`. `LANGSMITH_OPENCODE_REDACT_EXTRA` takes a JSON array of `{ pattern, replace }` custom rules. Bumps `langsmith` to `^0.7.13`.

## 0.0.3

### Patch Changes

- [#5](https://github.com/langchain-ai/langsmith-opencode/pull/5) [`de9e69c`](https://github.com/langchain-ai/langsmith-opencode/commit/de9e69c81ce55e7aef902db570d37afa827765d0) Thanks [@dqbd](https://github.com/dqbd)! - Fix incorrect LLM turn timestamps

## 0.0.2

### Patch Changes

- [#2](https://github.com/langchain-ai/langsmith-opencode/pull/2) [`3c4f83f`](https://github.com/langchain-ai/langsmith-opencode/commit/3c4f83fe0f81ea51e63021e06da6a90f6e62aa56) Thanks [@dqbd](https://github.com/dqbd)! - Ensure that the trace is flushed when idle
