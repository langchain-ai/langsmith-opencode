---
"@langchain/langsmith-opencode": minor
---

Adopt the coding-agent-v1 trace metadata contract. Every run now carries standardized identity (`ls_agent_kind`, `ls_agent_runtime`, `ls_trace_schema_version`), version (`ls_integration_version`, `ls_agent_runtime_version`), turn (`turn_id`, `turn_number`), and repository/git/`cwd` keys, and `thread_id` now lands on every run so LLM/tool/subagent runs group correctly. Subagent sub-sessions are grouped under the parent thread with `ls_subagent_id`/`ls_subagent_type`. Renames `ls_integration` from `"opencode-js"` to `"opencode"` and drops the non-contract `ls_agent_type` key.
