---
"@langchain/langsmith-opencode": minor
---

Supports OpenCode v2

Also fixes two things for v1 users, since they share the same tracer: tool and subagent runs no longer get charged their parent model call's tokens, and a subagent's work is only nested once even when more than one tool call points at it.
