# Changelog

All notable changes to WayCode are documented here.

## [Unreleased]

### Fixed
- **Local models no longer time out because the context window was too big for
  the machine.** Asked to delete one card from an attached HTML page, the coder
  ran its search and then died on `Request timed out after 300s`. Nothing was
  broken: `num_ctx` was sized from the size of the prompt alone, the attachment
  pushed it to 32768, and on a 16GB M2 a 6GB KV cache plus 9GB of weights no
  longer fits on the GPU. Measured on that machine with qwen2.5-coder:14b —
  8192: 7.9 tok/s, 16384: 8.4 tok/s, 32768: **0.12 tok/s**, about 8 seconds per
  token. The request was never hung, just 70× too slow to finish.

  `num_ctx` is now the smallest of what the request needs, what the model was
  trained for, and what this machine can hold alongside the weights — computed
  from the model's real KV geometry (layers × KV heads × head width), read from
  Ollama. A window is never requested that the hardware cannot fill.

- **Ollama no longer reloads the model between turns.** The window used to grow
  with the conversation (8k → 16k → 32k), and every change made Ollama unload
  and reload the model — 63 seconds of dead air, before a single token. The
  window now holds its high-water mark for the session.

- **Requests are streamed, so a slow model is not killed for being slow.** The
  old 300s cap was a wall-clock deadline on the whole reply. The limit is now
  silence rather than duration, with a separate and much longer allowance for
  the first token, since a local model sends nothing at all while it loads and
  reads the prompt — measured at 695s for a 14k-token prompt.

- **A prompt too large for the window is now reported, not silently truncated.**
  Ollama drops the overflow without a word, which usually takes the tool
  definitions with it — the model then "ignores its tools" for no visible
  reason. WayCode now says so, and says what to do about it.

## [1.0.2]

### Added
- **The model can see images.** Attached or pasted pictures are sent as real
  image content to Anthropic, OpenAI and Ollama vision models, not just named as
  a path. SVG stays text (it is editable XML) and oversized images are skipped
  with a note rather than failing the request.

- **`copy_file` — duplicating a file no longer goes through the model.** Asked to
  "make index.html again as indxxx.html", the coder read the 495-line page and
  then *re-created* it from memory, producing a 284-byte placeholder that shared
  nothing with the original but the doctype. Duplication is deterministic, so it
  now has a tool: `copy_file` copies byte for byte (aliased from `cp`, `copy`,
  `rename_file`, `mv`, `duplicate_file`), refuses to clobber an existing file
  unless asked, and always prompts when it would replace real content. The system
  prompt tells the agent to copy and then edit the copy, never to regenerate.
- **Paste and drag-and-drop attachments** — Cmd+V a screenshot or drag a file
  from Finder onto the chat. A clipboard image has no filename, so one is
  generated from its MIME type; pasted text still behaves normally.
- **Send while the agent is working.** Send no longer locks during a run: a
  message typed mid-turn is shown immediately, queued, and runs when the current
  one finishes. Pressing Stop discards the queue, because Stop means "not this
  direction".

- **Upload files and images from anywhere** — the 📎 button opens a native file
  dialog, copies what you pick into `.waycode/uploads/` in the workspace and
  attaches it as a context chip. Copying is deliberate: every tool refuses to
  resolve a path outside the workspace, so a file left elsewhere would be visible
  in the chat but unreadable to the agent. Binary and image attachments are named
  and sized in the prompt instead of being inlined as mojibake.
- **New task, history and settings moved to the top bar**, leaving the composer
  for composing. The status line moved to its own row so the model and mode text
  is no longer squeezed, and Stop is now styled as a stop.
- **One conversation across both agents** — in multi-agent mode the coder was
  only ever shown the English task spec, so a chat-only turn ("call it Test, not
  waycode") never reached it and the two roles remembered different
  conversations. Chat turns and the final user-facing explanation are now
  recorded into the coder's history too.

- **SEARCH/REPLACE edits — file editing that works on any model.** Small local
  coder models cannot reliably emit a tool call for an edit: measured here, asked
  to add a card to a 495-line file, qwen2.5-coder truncates the JSON around 990
  characters and sends an empty `old_text`, so the run ends having read the file
  and changed nothing. Those same models emit SEARCH/REPLACE diff blocks well —
  it is the format they were trained on. WayCode now accepts them, converts them
  into ordinary `edit_file`/`create_file` calls, and applies them through the
  usual diff preview, approval and path-safety checks. A block with no path falls
  back to the file the model last touched. Strong models keep using native tool
  calls; weak ones finally have a route that works instead of failing silently.
- **Ollama model scanning** — the model pickers now read each installed model's
  size, parameter count, quantization, context window and tool-calling capability
  straight from the machine, rank them by fitness for the coder role, and warn
  before you pick one that cannot drive the tools. Includes two recommended local
  coder models with their real RAM requirements, and an honest note when this
  machine cannot host either.

### Added
- **Per-conversation context file** — every chat now keeps its own markdown
  context file recording each turn: what was asked, which tools *actually* ran,
  and the answer given. Both the language bot and the coder read it at the start
  of every turn, so context survives reloads, history trimming, and reopening an
  old conversation. Open it with *WayCode: Open Conversation Context File*.

### Fixed
- **The coder was being told to answer in Hebrew.** The multi-agent config was
  copied to the coder unchanged, so a code model was ordered to reply in the
  user's language — the exact thing the communicator's own prompt warns about.
  A 14B coder handed that instruction degenerated into mixed Hebrew/Arabic
  ("אני אסרח الآن") and stopped calling tools altogether. The coder now always
  works in English; translating back is the communicator's job.
- **A stuck model is no longer nudged in circles.** When a reply comes back
  word-for-word identical to the previous one, the model is not reconsidering —
  it is stuck. The loop now stops and reports honestly instead of burning five
  more rounds on the same sentence.
- **Searching for Hebrew text is now forbidden in the prompt.** The coder was
  grepping for a Hebrew phrase that could not appear in HTML markup, finding
  nothing, and concluding the feature was absent.

- **Reopening a saved conversation no longer loses its context** — loading a
  thread from the history repainted the chat but left the *model* with an empty
  history, so the bots had no idea what had been discussed. The conversation is
  now replayed into both roles. The same replay covers a mid-thread model switch.
- **"Webview is disposed" when reopening the editor-tab chat** — the panel's
  dispose handler read `panel.webview`, which throws once the panel is gone. The
  handler aborted before clearing the stale panel handle, so the next *Open in
  Editor Tab* tried to reveal a dead panel. The webview is now captured up front,
  the same fix is applied to the sidebar view, and a stale handle is recreated
  instead of surfacing an error.
- **Half-finished multi-part tasks** — asking for a README *and* a landing page
  could produce only the README, with the coder reporting success. The
  orchestrator now compares the files the task spec names against the files any
  tool actually touched, and makes the coder finish the ones it skipped. The task
  spec also carries an explicit `Deliverables:` list so nothing is dropped in
  translation.
- **A blank chat panel after being hidden and reshown** now repaints the
  conversation in progress instead of starting empty.
- Webview message listeners are disposed on unbind, and a rejected `postMessage`
  to a disposed webview no longer leaves an unhandled rejection.
- **Pressing Stop no longer breaks the rest of the conversation.** Cancelling
  mid-turn left tool calls with no matching result in the history, which every
  chat API rejects — so every later message failed until *New Task*. Skipped
  calls now get an explicit "cancelled" result. In multi-agent mode, Stop also
  used to restart the coder immediately, because each follow-up nudge cleared the
  agent's own cancelled flag.
- **A second message can no longer start while one is still running.** Two turns
  sharing a runner interleaved their messages and corrupted the same tool
  pairing; an error mid-run also re-enabled Send, which is how it happened.
- **Previews of large files no longer freeze the extension.** The diff builder
  allocated a table the size of *before × after* lines, so writing a big file
  could allocate hundreds of millions of cells. It now diffs only the part that
  actually changed, shows hunks instead of the whole file, and caps the preview.
- **A tool-free request no longer sends an empty `tools: []`** — the OpenAI API
  rejects it outright, which broke the communicator role on that provider.
- **"WayCode: New Task" now actually starts a new task.** The command announced
  one but never cleared the thread, so the next message still carried the whole
  previous conversation. Relatedly, *New Task* no longer leaves the old
  conversation queued for a coder built later in the pipeline.
- **A coder whose provider fails is no longer nudged twice more**, which repeated
  the same error three times; the failure is reported once and the explanation
  bot is told the task did not run instead of describing success.
- **Running out of agent steps says so** instead of stopping silently, which was
  indistinguishable from finishing.
- **The Claude CLI provider no longer crashes the extension host** when `claude`
  is not installed — the write to its stdin raised an unhandled EPIPE. It now
  also runs in the workspace folder.
- Turn numbering in the conversation context file no longer repeats after old
  turns are trimmed; the model read the duplicate as the same turn happening
  twice.
- Inline code and fenced blocks in a reply no longer render as `undefined` (or
  drop the whole message) when followed by a digit.
- Scanning for local Ollama models times out instead of hanging the model picker
  when the configured server is unreachable.

## [1.0.1]

### Added
- **README** — the extension shipped with an empty one; it now documents what
  WayCode does, the agent loop, the multi-agent pipeline, modes, tools,
  providers, commands and settings, with a Hebrew summary.
- **Package metadata** — `repository`, `bugs`, and `homepage`, so the README's
  relative links and the logo resolve on the Marketplace (and so `vsce package`
  succeeds at all).

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
