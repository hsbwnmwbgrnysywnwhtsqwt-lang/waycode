# Changelog

All notable changes to WayCode are documented here.

## [Unreleased]

### Added
- **Claude Code CLI provider** (`claude-cli`) — use Claude through your existing
  Claude Code subscription with no API key; ideal as the communicator role.
- **Grounded explanations** — the communicator reports only the coder's real tool
  actions and says plainly when nothing changed (fixes fabricated "all done").
- **Case-insensitive code search** and coaching to search broadly before giving up.
- **History trimming** so long, persisted conversations don't overflow small
  local-model context windows.
- **Ask About Selection** — select code in the editor, right-click → *WayCode: Ask
  About Selection*, and the chat is pre-filled with that snippet for your question.
- **Conversation continuity** — follow-up messages keep prior context; the runner
  is rebuilt only when the model/mode/language/approval/step-limit changes.
- **Ollama model discovery** — model pickers list installed Ollama models (via
  `/api/tags`) instead of requiring you to type names.
- **OpenAI-compatible endpoints** — `waycode.openai.baseUrl` points the OpenAI
  provider at LM Studio, Groq, Together, Azure, and similar servers.
- **Copy-code buttons**, a welcome/onboarding card, blockquotes, and rules in chat.
- **Smart routing** — the communicator bot classifies each message as CHAT
  (answers directly) or CODE (writes a spec for the coder), so plain questions no
  longer make a round-trip through the coder. The route is shown in the chat (🧭).
- **Reply-language selection** — `WayCode: Select Response Language` / `waycode.language`
  makes the assistant reply in a chosen language (Hebrew, English, Arabic, …) or
  `auto` to match the user. Threaded through both single-agent and multi-agent modes.
- **Live tool transparency** — tool cards now update in place (running → done/error),
  show the exact command/path being run, and reveal output on demand; each bot's
  reasoning renders as a 💭 thinking block.

### (earlier in this release)
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
