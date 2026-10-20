---
"@langchain/langsmith-opencode": minor
---

Support OpenCode 2.

OpenCode 2 replaced the plugin API and no longer emits the `message.updated` and `message.part.updated` events the plugin relied on, so the published package failed to load with `Plugin must export a default definition with an id and an effect or setup function` and traced nothing.

The package now default-exports a shared entrypoint: OpenCode 2 reads `id` and `setup()`, while OpenCode 1 keeps using the original `server()` hook implementation. OpenCode 2 turns are submitted from a session snapshot taken when a session goes idle, and nested sub-sessions are attached under the tool call that spawned them.

Both versions emit the same `opencode.session` / `opencode.assistant.turn` run tree and the same `coding-agent-v1` metadata contract.
