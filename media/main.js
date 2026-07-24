// @ts-check
// WayCode chat webview — vanilla JS, no external dependencies (CSP-safe).
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById("input"));
  const sendBtn = document.getElementById("send");
  const cancelBtn = document.getElementById("cancel");
  const newTaskBtn = document.getElementById("newTask");
  const statusEl = document.getElementById("status");

  /** In-flight tool cards, keyed by tool-call id, so we can update them in place. */
  const toolCards = {};

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Is the text predominantly right-to-left (Hebrew/Arabic)?
  function isRTL(s) {
    const rtl = s.match(/[֐-׿؀-ۿ܀-߿]/);
    if (!rtl) return false;
    const ltr = s.match(/[A-Za-z]/);
    return !ltr || rtl.index < ltr.index;
  }

  function applyDir(node, text) {
    if (isRTL(text)) node.setAttribute("dir", "rtl");
  }

  // Inline markdown: `code`, **bold**, *italic*. Uses text sentinels (WCINLn)
  // to protect inline-code spans from the bold/italic passes.
  function inline(s) {
    s = escapeHtml(s);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return "WCINL" + (codes.length - 1) + "";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    s = s.replace(/WCINL(\d+)/g, function (_, i) {
      return '<code class="inline">' + codes[i] + "</code>";
    });
    return s;
  }

  // Minimal, safe markdown → HTML (headings, lists, fenced code, paragraphs).
  function renderMarkdown(src) {
    const blocks = [];
    src = src.replace(/```(\w*)\r?\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push({ lang: lang, code: code.replace(/\r?\n$/, "") });
      return "WCBLK" + (blocks.length - 1) + "";
    });
    const lines = src.split(/\r?\n/);
    let html = "";
    let list = null;
    const closeList = function () {
      if (list) {
        html += list === "ul" ? "</ul>" : "</ol>";
        list = null;
      }
    };
    for (const line of lines) {
      const blockMatch = line.match(/^\s*WCBLK(\d+)\s*$/);
      if (blockMatch) {
        closeList();
        const b = blocks[+blockMatch[1]];
        html +=
          '<div class="code-wrap"><button class="copy-btn" type="button">Copy</button>' +
          '<pre class="code" dir="ltr"' +
          (b.lang ? ' data-lang="' + escapeHtml(b.lang) + '"' : "") +
          "><code>" +
          escapeHtml(b.code) +
          "</code></pre></div>";
        continue;
      }
      if (/^\s*$/.test(line)) {
        closeList();
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeList();
        html += "<hr />";
        continue;
      }
      let m;
      if ((m = line.match(/^\s*>\s?(.*)$/))) {
        closeList();
        html += "<blockquote>" + inline(m[1]) + "</blockquote>";
        continue;
      }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        closeList();
        const lvl = m[1].length;
        html += "<h" + lvl + ">" + inline(m[2]) + "</h" + lvl + ">";
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        if (list !== "ul") {
          closeList();
          html += "<ul>";
          list = "ul";
        }
        html += "<li>" + inline(m[1]) + "</li>";
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (list !== "ol") {
          closeList();
          html += "<ol>";
          list = "ol";
        }
        html += "<li>" + inline(m[1]) + "</li>";
      } else {
        closeList();
        html += "<p>" + inline(line) + "</p>";
      }
    }
    closeList();
    return html;
  }

  function addMessage(role, text) {
    removeWelcome();
    const node = el("div", "msg " + role);
    applyDir(node, text);
    if (role === "assistant" || role === "error") {
      node.innerHTML = renderMarkdown(text);
    } else {
      node.textContent = text;
    }
    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  function addLog(text) {
    const node = el("div", "log", text);
    applyDir(node, text);
    messagesEl.appendChild(node);
    scrollToBottom();
  }

  // A bot's reasoning — shown as a readable, visually-secondary block.
  function addThinking(text) {
    const node = el("div", "thinking");
    applyDir(node, text);
    node.textContent = "💭 " + text;
    messagesEl.appendChild(node);
    scrollToBottom();
  }

  function renderDiff(diff) {
    const pre = el("pre", "diff");
    diff.split("\n").forEach(function (line) {
      const span = el("span");
      span.textContent = line + "\n";
      if (line.startsWith("+")) span.className = "diff-add";
      else if (line.startsWith("-")) span.className = "diff-del";
      pre.appendChild(span);
    });
    return pre;
  }

  // A one-line human summary of what a tool is about to do.
  function summarizeInput(name, input) {
    if (!input) return "";
    if (input.command) return "$ " + input.command;
    if (input.args) return "git " + input.args;
    if (input.path && input.pattern) return input.path + "  ·  /" + input.pattern + "/";
    if (input.path) return input.path;
    if (input.pattern) return "/" + input.pattern + "/";
    const keys = Object.keys(input);
    return keys.length ? JSON.stringify(input) : "";
  }

  // Create a tool card in the "running" state. Returns the card handle.
  function startTool(id, name, input) {
    const wrap = el("div", "tool running");
    const head = el("div", "tool-head");
    head.appendChild(el("span", "name", "🔧 " + name));
    const status = el("span", "tool-status", "running…");
    head.appendChild(status);

    const sub = el("div", "tool-sub");
    const summary = summarizeInput(name, input);
    if (summary) sub.textContent = summary;

    const body = el("div", "tool-body hidden");
    head.addEventListener("click", function () {
      body.classList.toggle("hidden");
    });

    wrap.appendChild(head);
    if (summary) wrap.appendChild(sub);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    scrollToBottom();

    const card = { wrap: wrap, status: status, body: body };
    if (id) toolCards[id] = card;
    return card;
  }

  // Move a tool card to its finished state and show output / diff.
  function finishTool(card, isError, output, preview) {
    card.wrap.classList.remove("running");
    card.wrap.classList.add(isError ? "error" : "done");
    card.status.textContent = isError ? "✗ error" : "✓";
    card.body.textContent = "";
    if (preview && preview.diff) {
      card.body.appendChild(renderDiff(preview.diff));
      card.body.classList.remove("hidden");
    } else {
      card.body.textContent = output || "(no output)";
      // Expand automatically on error; keep tidy on success.
      card.body.classList.toggle("hidden", !isError);
    }
    scrollToBottom();
  }

  function addApproval(id, preview) {
    const wrap = el("div", "approval");
    wrap.appendChild(el("div", "title", "⚠️ Approval required: " + preview.title));
    if (preview.diff) {
      wrap.appendChild(renderDiff(preview.diff));
    } else if (preview.detail) {
      const pre = el("pre", "diff");
      pre.textContent = preview.detail;
      wrap.appendChild(pre);
    }
    const actions = el("div", "approval-actions");
    const approve = el("button", "primary", "Approve");
    const reject = el("button", "", "Reject");
    const finish = function (approved) {
      vscode.postMessage({ type: "approval", id: id, approved: approved });
      approve.disabled = reject.disabled = true;
      wrap.appendChild(el("div", "log", approved ? "✔️ Approved" : "✖️ Rejected"));
    };
    approve.addEventListener("click", function () {
      finish(true);
    });
    reject.addEventListener("click", function () {
      finish(false);
    });
    actions.appendChild(approve);
    actions.appendChild(reject);
    wrap.appendChild(actions);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function setRunning(running) {
    sendBtn.classList.toggle("hidden", running);
    cancelBtn.classList.toggle("hidden", !running);
    inputEl.disabled = running;
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "send", text: text });
    inputEl.value = "";
  }

  sendBtn.addEventListener("click", send);
  cancelBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "cancel" });
  });
  newTaskBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "newTask" });
  });

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Copy-code buttons (event delegation, since code blocks are built as HTML).
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  messagesEl.addEventListener("click", function (e) {
    const target = /** @type {HTMLElement} */ (e.target);
    if (!target || !target.classList || !target.classList.contains("copy-btn")) return;
    const wrap = target.parentElement;
    const code = wrap && wrap.querySelector("pre.code code");
    if (code) {
      copyText(code.textContent || "");
      target.textContent = "Copied";
      setTimeout(function () {
        target.textContent = "Copy";
      }, 1200);
    }
  });

  function removeWelcome() {
    const w = messagesEl.querySelector(".welcome");
    if (w) w.remove();
  }

  function showWelcome() {
    const w = el("div", "welcome");
    w.innerHTML = renderMarkdown(
      [
        "### 👋 Welcome to WayCode",
        "I'm your AI coding agent. To get started:",
        "- **WayCode: Set API Key** — add a provider key (Ollama needs none).",
        "- **WayCode: Configure Agent Roles** — pick a language bot + a coder bot.",
        "- **WayCode: Select Response Language** — reply in Hebrew, English, and more.",
        "",
        "Open a project folder, then ask me anything — in your own language.",
      ].join("\n")
    );
    messagesEl.appendChild(w);
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    switch (msg.type) {
      case "status":
        statusEl.textContent = msg.text;
        break;
      case "userMessage":
        addMessage("user", msg.text);
        break;
      case "assistant":
        addMessage("assistant", msg.text);
        break;
      case "phase":
        messagesEl.appendChild(el("div", "phase", msg.label));
        scrollToBottom();
        break;
      case "thinking":
        addThinking(msg.text);
        break;
      case "log":
        addLog(msg.text);
        break;
      case "toolStart":
        startTool(msg.id, msg.name, msg.input);
        break;
      case "toolEnd": {
        let card = msg.id ? toolCards[msg.id] : null;
        if (!card) card = startTool(msg.id, msg.name, {});
        finishTool(card, msg.isError, msg.output, msg.preview);
        if (msg.id) delete toolCards[msg.id];
        break;
      }
      case "approvalRequest":
        addApproval(msg.id, msg.preview);
        break;
      case "running":
        setRunning(msg.value);
        break;
      case "error":
        addMessage("error", "❌ " + msg.text);
        setRunning(false);
        break;
      case "cleared":
        messagesEl.innerHTML = "";
        showWelcome();
        addLog("Started a new task.");
        break;
      case "focusInput":
        inputEl.focus();
        break;
    }
  });

  showWelcome();
  vscode.postMessage({ type: "ready" });
})();
