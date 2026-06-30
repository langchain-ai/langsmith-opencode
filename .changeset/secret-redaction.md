---
"@langchain/langsmith-opencode": minor
---

Redact secrets from traces before upload using the SDK's `createSecretAnonymizer()` preset, set on the tracing `Client`. On by default; opt out with `LANGSMITH_OPENCODE_REDACT=false`. `LANGSMITH_OPENCODE_REDACT_EXTRA` takes a JSON array of `{ pattern, replace }` custom rules. Bumps `langsmith` to `^0.7.13`.
