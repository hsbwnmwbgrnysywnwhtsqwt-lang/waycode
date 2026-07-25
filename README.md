# WayCode

**WayCode** is a professional AI coding agent for Visual Studio Code — a senior-engineer-style assistant in the spirit of Claude Code / Cursor / Codex. It understands natural language (including **Hebrew**), reads and reasons about whole projects, writes and edits code, runs tests, and fixes its own mistakes.

> Status: **v0.1 MVP** — a working, extensible foundation. Architected to grow into a real product.

---

## ✨ Features

- **Chat sidebar _and_ full editor tab** — work in the WayCode sidebar, or click the
  pop-out button (or run **WayCode: Open in Editor Tab**) for a full-window chat.
  Both share one conversation.
- **Modes menu** — a pill in the composer (or **Shift+Tab** to cycle) to switch how the
  agent acts:
  - **✋ Manual** — ask before each edit
  - **⟨⟩ Auto-edit** — edit files automatically; ask before commands
  - **📋 Plan** — explore read-only and present a step-by-step plan, no changes
  - **🌙 Auto** — auto-approve everything (no questions)
- **Attach files as context** — a ➕ button in the composer (or right-click a file →
  *Add File to Context*) attaches files as chips; their contents ride along with your
  next message so the agent focuses on exactly what you mean.
- **Visual settings page** — **WayCode: Settings** (⚙ in the chat, sidebar header, or
  Command Palette) opens a full page to set provider, models, multi-agent roles,
  **reply language**, approvals, endpoints, and API keys — no digging through VS Code
  settings.
- **Top-bar button** — a WayCode icon in the editor title bar (like Claude/Codex) opens
  the chat in an editor tab.
- **Command Palette** integration (`WayCode: …`).
- **Agent engine** that plans → acts → verifies → fixes in a loop.
- **Multi-agent pipeline (role-based)** — an optional mode where a **communicator bot** (strong at your language, e.g. Hebrew) understands you and explains results, while a separate **coder bot** (strong at code, e.g. Qwen Coder) does the engineering. Each role runs on its own provider/model.
- **Pluggable AI providers** — switch between **Anthropic (Claude)**, **OpenAI (GPT)**, **Google (Gemini)**, and **local models via Ollama** with one command.
- **Tool system** — read/create/edit files, search code, run the terminal, git, tests, linters, and an error analyzer.
- **Change previews & approval** — every write/command is shown as a diff or command and requires your approval before it runs.
- **Memory & context** — remembers project structure, pinned files, decisions, and preferences per workspace.

---

## 🏗 Architecture

```
src/
├── extension.ts            # Activation, commands, wiring
├── config.ts               # Settings + secret API-key storage
├── providers/              # AI backends behind one interface
│   ├── types.ts            #   neutral request/response/tool types
│   ├── AnthropicProvider.ts
│   ├── OpenAIProvider.ts
│   ├── GeminiProvider.ts
│   ├── OllamaProvider.ts
│   └── ProviderFactory.ts  #   createProvider(id, creds) — swap models here
├── tools/                  # Every agent capability is a Tool
│   ├── Tool.ts             #   Tool interface + approval/preview types
│   ├── FileTools.ts        #   read / create / write / edit / list
│   ├── CommandTools.ts     #   terminal / git / tests / linter
│   ├── SearchTools.ts      #   code search + error analyzer
│   ├── diff.ts             #   diff preview generator
│   └── ToolRegistry.ts     #   the set exposed to the model
├── context/ProjectContext.ts  # Builds a compact project snapshot
├── memory/Memory.ts           # Persistent per-workspace memory
├── agent/
│   ├── Agent.ts            # plan → act → verify → fix loop (the coder bot)
│   ├── Orchestrator.ts     # multi-agent pipeline (communicator ↔ coder)
│   └── prompts.ts          # senior-engineer + communicator prompts
└── ui/ChatViewProvider.ts  # Webview host (bridges UI ↔ Agent)

media/                      # Webview assets (vanilla JS/CSS, CSP-safe)
```

**Design principle:** everything is behind an interface. The agent depends only on `AIProvider` and `Tool`, so adding a model or a capability never touches the core loop.

---

## 🚀 Getting started

### Prerequisites
- VS Code ≥ 1.85
- Node.js ≥ 18

### Run in development
```bash
npm install
npm run compile        # or: npm run watch
npm test               # run the unit test suite (node:test)
```
Then press **F5** in VS Code ("Run WayCode Extension") to open an Extension Development Host.

The test suite (`src/test/`) covers the pure logic that must not regress: the diff
generator, workspace path-safety, the local-model tool-call recovery parser, and
the HTTP timeout/error handling. It runs on Node's built-in test runner — no extra
dependencies — and in CI (GitHub Actions) on Node 18 and 20.

### Configure a model
1. `Cmd/Ctrl+Shift+P` → **WayCode: Set API Key** → pick a provider and paste your key
   (stored securely in VS Code Secret Storage; Ollama needs no key).
2. **WayCode: Select Model / Provider** → choose provider + model id.
3. Open the **WayCode** icon in the Activity Bar and start chatting.

### Default models
| Provider  | Default model            | Key required |
|-----------|--------------------------|--------------|
| Anthropic | `claude-sonnet-4-5`      | ✅           |
| OpenAI    | `gpt-4o`                 | ✅           |
| Gemini    | `gemini-2.0-flash`       | ✅           |
| Ollama    | `llama3.1` (local)       | ❌           |
| Claude Code (CLI) | `sonnet`         | ❌ (uses your Claude subscription) |

**Claude Code CLI provider (no API key):** if you have the `claude` CLI installed
and signed in, pick provider **`claude-cli`** to use Claude through your existing
subscription — no key needed. It's a text backend (no WayCode tool-calling), so it
shines as the **communicator** role: pair Claude (excellent Hebrew, free via your
subscription) as the language bot with a local Ollama model as the coder.

---

## ⚙️ Settings

| Setting | Description | Default |
|---|---|---|
| `waycode.provider` | Active provider | `anthropic` |
| `waycode.model` | Model id | `claude-sonnet-4-5` |
| `waycode.ollama.baseUrl` | Ollama server URL | `http://localhost:11434` |
| `waycode.openai.baseUrl` | OpenAI-compatible endpoint (LM Studio, Groq, Azure…) | `` (api.openai.com) |
| `waycode.maxAgentSteps` | Max tool iterations per task | `25` |
| `waycode.autoApproveReads` | Auto-approve read-only tools | `true` |
| `waycode.autoApprove.fileEdits` | Auto-approve file create/edit/write | `false` |
| `waycode.autoApprove.commands` | Auto-approve terminal/git/test/lint | `false` |

### Approval modes

Run **WayCode: Set Approval Mode** to choose how much the agent may do without asking:

| Mode | Reads | File edits | Commands |
|---|:--:|:--:|:--:|
| Ask for everything | ask | ask | ask |
| Auto-approve reads only *(default)* | auto | ask | ask |
| Auto-approve file edits | auto | auto | ask |
| Auto-approve commands | auto | ask | auto |
| Auto-approve everything (YOLO) | auto | auto | auto |

The current mode is shown in the chat's status line (🔓). Every write/command still shows a diff or the command text in the log so you can see exactly what happened.

---

## 🤖 Multi-agent pipeline (role-based)

Turn it on with **WayCode: Configure Agent Roles**. You pick a model for each role:

```
   user (Hebrew / any language)
        │
        ▼
  ┌─────────────────────┐   Communicator bot
  │ understands intent, │   → strong at language (e.g. Claude / Gemini)
  │ writes a task spec  │
  └─────────────────────┘
        │  precise English task spec
        ▼
  ┌─────────────────────┐   Coder bot
  │ writes / edits code │   → strong at code (e.g. qwen2.5-coder via Ollama)
  │ runs & fixes (loop) │      need not speak your language
  └─────────────────────┘
        │  code + verification (lint / tests)
        ▼
  ┌─────────────────────┐   Communicator bot
  │ explains the result │   → back in your language
  └─────────────────────┘
```

Why: the language-strong model talks to you, while a code-strong (and often cheaper/faster) model does the engineering — no single model has to be great at everything. When multi-agent is **off**, one agent handles the whole task.

**Smart routing:** the communicator bot decides, per message, whether it's a plain
conversation/question (it answers directly — no coder involved) or an actual coding
task (it writes a spec and hands it to the coder). The routing decision is shown in
the chat (🧭).

**Reply language:** run **WayCode: Select Response Language** (or set `waycode.language`)
to force replies into Hebrew, English, Arabic, and more — or leave it on `auto` to
match whatever language you write in.

**Transparency:** every tool the agent runs appears as a live card showing the exact
command/path, a running→done/error status, and its output; each bot's reasoning is
shown as a 💭 thinking block.

Relevant settings: `waycode.multiAgent.enabled`, `waycode.roles.communicator.{provider,model}`, `waycode.roles.coder.{provider,model}`, `waycode.language`.

## 🧠 How the agent works
1. **Understand** — reads relevant files; never edits unread code.
2. **Plan** — states a short step-by-step plan for non-trivial tasks.
3. **Act** — uses tools to search, create, and edit code and run commands.
4. **Verify** — runs the build/tests/linter after changes.
5. **Fix** — analyzes failures and iterates until green (or reports a real blocker).

---

## 🗺 Roadmap
- Streaming responses token-by-token
- React-based webview with rich markdown/code rendering
- Multi-file atomic apply with a review panel
- Semantic project indexing / embeddings retrieval
- Inline (editor) code actions and quick fixes
- Test-generation and coverage-aware fixing
- More providers (Azure OpenAI, Mistral, Groq)

---

## 📄 License
MIT
