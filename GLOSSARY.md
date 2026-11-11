# Agent Hub

A live pane beside a Claude Code session that shows what the session is doing and what it costs.

## Language

**LSP activity**:
The language-server calls Claude makes during the session, such as go-to-definition or find references.
_Avoid_: LSP (alone)

The engine exposes no language-server status or diagnostics to a mod, so the pane shows only these calls.
