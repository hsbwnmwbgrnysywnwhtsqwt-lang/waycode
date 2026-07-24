# Changelog

All notable changes to WayCode are documented here.

## [Unreleased]

### Added
- **Configurable approval modes** — `WayCode: Set Approval Mode` lets you choose
  between asking for everything, auto-approving reads, file edits, commands, or
  everything (YOLO). Current mode is shown in the chat status line.
- **Rich chat rendering** — assistant messages render markdown (headings,
  bold/italic, inline code, lists, fenced code blocks with a language label) and
  are laid out right-to-left for Hebrew/Arabic while code stays left-to-right.
- **Unit test suite** on Node's built-in test runner covering the diff generator,
  workspace path-safety, local-model tool-call recovery, and HTTP error handling.
- **GitHub Actions CI** — type-check, compile, and test on Node 18 and 20.
- **Network timeouts** for all providers via a shared HTTP helper, with readable
  error messages (prevents indefinite hangs when a local model is loading).

### Fixed
- Local Ollama models (e.g. `qwen2.5-coder`) that emit tool calls as JSON text —
  as `<tool_call>` tags, ```json fences, bare objects, or embedded in prose — are
  now parsed correctly, so the agent can actually create and edit files.

## [0.1.0]

### Added
- Initial WayCode: VS Code AI coding agent.
- Provider abstraction for Anthropic, OpenAI, Gemini, and Ollama.
- Tool system: read/create/edit/write/list files, code search, terminal, git,
  tests, linter, and error analyzer — with path-traversal guards and diff previews.
- Agent engine with a plan → act → verify → fix loop.
- Multi-agent role pipeline: a communicator bot (language) + a coder bot (code),
  each on its own provider/model.
- Project-context snapshot and persistent per-workspace memory.
- Chat webview sidebar with approval-before-write and Command Palette commands.
