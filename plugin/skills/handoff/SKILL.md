---
name: handoff
description: Resume the current Claude Code conversation with ClaudeCodeRemoteControl enabled.
disable-model-invocation: true
---

Call ClaudeCodeRemoteControl's `prepare_handoff` MCP tool exactly once. Show its returned command verbatim and explain that the user must exit this Claude session before executing it in the same terminal. Do not launch a second Claude process from inside the current session and do not terminate the current process yourself.
