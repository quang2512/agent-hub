# Agent Hub

A live pane beside a Claude Code session that shows what the session is doing and what it costs.

## Language

**LSP server**:
A language server the session has loaded through a plugin, for one or more languages.
_Avoid_: LSP (alone), language service

**Diagnostics**:
The errors and warnings an LSP server reports about files in the session.
_Avoid_: lint errors, problems

**LSP activity**:
The language-server calls Claude makes during the session, such as go-to-definition or find references.
_Avoid_: LSP (alone)
