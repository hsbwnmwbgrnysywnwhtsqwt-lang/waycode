<div align="center">

<img src="media/logo.png" alt="WayCode" width="160" />

# WayCode

**An AI coding agent that lives in your VS Code sidebar — talks to you in your language, works on your whole project, and never changes a file behind your back.**

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-1A1A20.svg)](CHANGELOG.md)

</div>

---

## What is WayCode?

WayCode is a VS Code extension that turns a chat panel into a real coding agent. You describe what you
want — in English, Hebrew, Arabic, or anything else — and it reads your repository, searches the code,
writes and edits files, runs your tests and linter, reads the errors, and fixes them. Every risky step
shows you a **diff or the exact command** and waits for your approval, unless you tell it not to.

It is **provider-agnostic**: Claude, GPT, a local Ollama model, or your existing Claude Code CLI
subscription. And it can split the work between **two models** — one that's great at your language and
one that's great at code.

```
┌──────────────────────────────────────────────────────────────┐
│  You: "תוסיף בדיקות ל-History ותריץ אותן"                    │
├──────────────────────────────────────────────────────────────┤
│  🔍 search_code  /class History/            → 3 matches      │
│  📖 read_file    src/memory/History.ts      → 62 lines       │
│  ✅ create_file  src/test/history.test.ts   → [diff] approve?│
│  🧪 run_tests    npm test                   → 14 pass        │
├──────────────────────────────────────────────────────────────┤
│  WayCode: הוספתי 5 בדיקות ל-History. כל 14 הבדיקות עוברות.   │
└──────────────────────────────────────────────────────────────┘
```

---

## Highlights

| | |
|---|---|
| 🌍 **Speaks your language** | Write in Hebrew (or any language) — WayCode understands, and replies in the same language. Chat is laid out RTL automatically while code stays LTR. |
| 🧠 **Whole-project awareness** | Every task starts with a snapshot of your file tree, manifests, and detected languages — no need to paste files. |
| 🔁 **Plan → act → verify → fix** | The agent doesn't stop at a suggestion. It edits, runs the build/tests, reads the failures, and iterates. |
| 🤝 **Two-model pipeline** | An optional *communicator* bot (language-strong, can run locally) talks to you; a *coder* bot (code-strong) does the engineering. |
| 🛡️ **You stay in control** | Diff previews before writes, the exact command before execution, four approval modes, and a read-only Plan mode. |
| 🔌 **Any provider** | Anthropic, OpenAI (and any OpenAI-compatible endpoint), local Ollama, or the Claude Code CLI — no API key needed for the last two. |
| 🚫 **No hallucinated success** | In multi-agent mode the explanation is built from the coder's *actual* tool calls, so "all done ✅" can't be invented. |
| 💾 **Remembers** | Per-project context file, per-workspace memory, and searchable conversation history. |

---

## Quick start

1. **Install** — from the Marketplace, or build a `.vsix` locally (see [Development](#development)).
2. **Open the panel** — click the WayCode icon in the Activity Bar, or run `WayCode: Open Chat`.
3. **Pick a model** — `WayCode: Select Model / Provider`.
4. **Add a key if needed** — `WayCode: Set API Key` (stored in VS Code Secret Storage, never in settings).
5. **Ask for something** — "add input validation to the login form and run the tests".

<details>
<summary><b>Zero-cost setup (no API key)</b></summary>

Two ways to run WayCode without paying per token:

- **Local Ollama** — install [Ollama](https://ollama.com), pull a model (`ollama pull qwen2.5-coder`,
  `ollama pull gemma2`), then choose provider *Ollama (local)*. The model picker lists what you have
  installed. Everything stays on your machine.
- **Claude Code CLI** — if you already have a Claude subscription with the `claude` CLI installed,
  choose provider *Claude Code (CLI, no key)*. Note: the CLI provider is text-only, so use it as the
  **communicator** or in single-agent chat — it cannot drive WayCode's tools as the coder.

</details>

---

## How it works

### Single-agent mode (default)

One model does everything, in a bounded tool-use loop:

```
   your message
        │
        ▼
  ┌───────────┐   tool call    ┌────────────────────────┐
  │   model   │ ─────────────▶ │ read · search · edit    │
  │  (agent)  │ ◀───────────── │ terminal · tests · lint │
  └───────────┘    result      └────────────────────────┘
        │            ▲                    │
        │            └── approval ────────┘  (diff / command shown to you)
        ▼
   final answer            up to `maxAgentSteps` iterations (default 25)
```

If the model announces a plan but calls no tool, WayCode detects the stall and nudges it to *act* —
so you don't get a to-do list instead of working code.

### Multi-agent mode (`waycode.multiAgent.enabled`)

Two models, each doing what it's best at:

```
  you (any language)
        │
        ▼
  🗣️  COMMUNICATOR ──── CHAT? ────▶ answers you directly (no coder round-trip)
        │
      CODE? → precise English task spec
        │
        ▼
  👨‍💻  CODER  ──▶ tools ──▶ verify (tests / lint) ──▶ fix ──▶ repeat
        │
        ▼  ground truth: the exact tool calls that really ran
  🗣️  COMMUNICATOR ──▶ explains the result in your language
```

The communicator can be a small local model (default: `gemma2` on Ollama) while the coder is a
code-strong model — and it only ever reports what actually happened.

---

## Modes

Switch with the mode button in the chat, or cycle with <kbd>Shift</kbd>+<kbd>Tab</kbd>.

| Mode | Reads | File edits | Commands |
|---|---|---|---|
| ✋ **Manual** | auto | ask | ask |
| ⟨⟩ **Auto-edit** | auto | auto | ask |
| 📋 **Plan** | auto | **blocked** — explores and proposes a plan only | **blocked** |
| 🌙 **Auto** | auto | auto | auto |

Even in 🌙 Auto, an overwrite that would wipe most of an existing file still asks — a "summary" write
that collapses a 500-line file is never approved silently.

---

## Tools

| Tool | Risk | What it does |
|---|---|---|
| `read_file` | read | Read a text file (size-capped) |
| `list_files` | read | List a directory |
| `search_code` | read | ripgrep (or `grep -E` fallback), case-insensitive, glob-filterable |
| `analyze_error` | read | Extract `file:line` locations and error codes from build/test output |
| `create_file` | write | Create a new file — shows a diff |
| `edit_file` | write | Replace a unique snippet — shows a diff |
| `write_file` | write | Overwrite a file — shows a diff, gated when destructive |
| `run_terminal` | execute | Any shell command in the workspace root |
| `run_tests` | execute | Your test command (default `npm test`) |
| `run_linter` | execute | Your lint command |
| `git` | execute | `status`/`diff`/`log` run freely; `add`/`commit`/`checkout` ask |

**Guardrails:** every path is resolved inside the workspace (no `../` escapes), and commands that never
exit (`npm run dev`, `vite`, `tsc --watch`, `docker compose up`, …) are refused with a pointer to a
one-shot check instead — so a run can't burn its budget on a watcher. Tool names models commonly guess
(`bash`, `str_replace`, `ls`, `grep`, …) are aliased to the real ones.

---

## Providers

| Provider | API key | Default model | Notes |
|---|---|---|---|
| **Anthropic (Claude)** | required | `claude-sonnet-4-5` | Full tool use |
| **OpenAI (GPT)** | required | `gpt-4o` | `waycode.openai.baseUrl` also targets LM Studio, Groq, Together, Azure |
| **Ollama (local)** | — | `gemma2` | Installed models are listed for you; tool calls emitted as JSON text are recovered |
| **Claude Code (CLI)** | — | `sonnet` | Uses your existing Claude subscription; text-only |

All providers share one HTTP layer with timeouts and readable errors, so a loading local model can't
hang the panel forever.

---

## Commands

| Command | Purpose |
|---|---|
| `WayCode: Open Chat` | Focus the sidebar chat |
| `WayCode: Open in Editor Tab` | Full-width chat in an editor tab |
| `WayCode: Settings` | Visual settings panel |
| `WayCode: New Task` | Start a fresh thread (archives the current one) |
| `WayCode: Conversation History` | Browse and reopen past conversations |
| `WayCode: Select Model / Provider` | Pick provider + model |
| `WayCode: Set API Key` | Store a key in Secret Storage |
| `WayCode: Configure Agent Roles` | Enable and configure the communicator/coder pipeline |
| `WayCode: Set Approval Mode` | Choose the approval policy |
| `WayCode: Select Response Language` | Reply language, or `auto` |
| `WayCode: Add File to Context` | Pin a file (also in the Explorer context menu) |
| `WayCode: Ask About Selection` | Select code → right-click → prefills the chat with it |
| `WayCode: Edit Project Context File` | Create/open `WAYCODE.md` |
| `WayCode: Open Conversation Context File` | Read what this conversation has recorded so far |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `waycode.provider` | `anthropic` | Active provider |
| `waycode.model` | `claude-sonnet-4-5` | Model id for the active provider |
| `waycode.language` | `auto` | Reply language (`auto` matches you) |
| `waycode.maxAgentSteps` | `25` | Max tool-use iterations per task |
| `waycode.autoApproveReads` | `true` | Auto-approve read-only tools |
| `waycode.autoApprove.fileEdits` | `false` | Auto-approve writes/edits/creates |
| `waycode.autoApprove.commands` | `false` | Auto-approve terminal/git/test/lint |
| `waycode.multiAgent.enabled` | `false` | Enable the communicator + coder pipeline |
| `waycode.roles.communicator.provider` / `.model` | `ollama` / `gemma2` | The language-facing role |
| `waycode.roles.coder.provider` / `.model` | inherit | The code-writing role |
| `waycode.ollama.baseUrl` | `http://localhost:11434` | Local Ollama server |
| `waycode.openai.baseUrl` | — | OpenAI-compatible endpoint |

---

## Project memory

WayCode carries four kinds of memory into every request:

- **`WAYCODE.md`** — a per-project context file you own (also read from `.waycode.md` or
  `.waycode/context.md`). Put the stack, conventions, and build/test commands there; it's injected into
  every system prompt. Run `WayCode: Edit Project Context File` to scaffold it.
- **Conversation context file** — one per chat, written automatically. Each turn appends what you
  asked, the tools that *actually* ran, and the answer you were given. **Both** the communicator and
  the coder read it at the start of every turn, so a conversation keeps its context across reloads,
  history trimming, and reopening it from 🕘. Run `WayCode: Open Conversation Context File` to read it.
- **Workspace memory** — pinned files, recorded decisions, and preferences, persisted per workspace.
- **Conversation history** — past threads, saved globally and reopenable from 🕘. Loading one replays
  it into the model, not just onto the screen.

---

## Development

```bash
npm install
npm run compile      # tsc -p ./
npm run watch        # rebuild on change
npm run typecheck    # tsc --noEmit
npm test             # node --test out/test/  (compiles first)
npm run lint
npx @vscode/vsce package   # → waycode-<version>.vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with WayCode loaded.
CI type-checks, compiles, and tests on Node 18 and 20.

### Layout

```
src/
├─ extension.ts          activation + all commands
├─ config.ts             settings & Secret Storage
├─ agent/
│  ├─ Agent.ts           the plan → act → verify → fix loop
│  ├─ Orchestrator.ts    communicator ⇄ coder pipeline
│  ├─ prompts.ts         system prompts
│  ├─ routing.ts         CHAT vs CODE classification
│  └─ history.ts         context-window trimming
├─ providers/            Anthropic · OpenAI · Ollama · Claude CLI (one interface)
├─ tools/                file · search · command tools, diffs, path safety
├─ context/              project snapshot + WAYCODE.md
├─ memory/               workspace memory · conversation history · per-chat context file
├─ ui/                   chat webview + settings panel
└─ test/                 node:test suite
```

Adding a provider means implementing `AIProvider` and registering it in `ProviderFactory`; adding a
tool means implementing `Tool` and listing it in `ToolRegistry.default()`. Nothing else changes.

---

<div dir="rtl">

## בעברית

**WayCode** הוא סוכן קוד מבוסס AI שיושב בסרגל הצד של VS Code. כותבים לו בעברית מה צריך — והוא קורא את
הפרויקט, מחפש בקוד, כותב ומתקן קבצים, מריץ בדיקות ולינטר, קורא את השגיאות ומתקן אותן. לפני כל שינוי
מסוכן הוא מציג **diff או את הפקודה המדויקת** ומחכה לאישור שלך.

- עונה בעברית, והצ'אט מיושר לימין אוטומטית (הקוד נשאר משמאל לימין).
- עובד עם Claude, GPT, מודל מקומי דרך Ollama, או מנוי Claude Code שכבר יש לך — בשתי האפשרויות
  האחרונות בלי API key ובלי עלות פר-טוקן.
- במצב שני-סוכנים: בוט אחד חזק בשפה מדבר איתך (יכול לרוץ מקומית), ובוט אחר חזק בקוד עושה את העבודה —
  וההסבר שאתה מקבל בנוי מהפעולות שבאמת בוצעו, כך שאין "הכול מוכן ✅" מומצא.
- ארבעה מצבי אישור, כולל מצב **תכנון** לקריאה בלבד שלא נוגע בקבצים.

</div>

---

<div align="center">

MIT © WayCode · [Changelog](CHANGELOG.md)

</div>
