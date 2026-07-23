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

  // Inline markdown: `code`, **bold**, *italic*. Uses text sentinels (WCINLn)
  // to protect inline-code spans from the bold/italic passes.
  function inline(s) {
    s = escapeHtml(s);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return "WCINL" + (codes.length - 1) + "";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    s = s.replace(/WCINL(\d+)/g, function (_, i) {
      return '<code class="inline">' + codes[i] + "</code>";
    });
    return s;
  }

  // Minimal, safe markdown → HTML (headings, lists, fenced code, paragraphs).
  function renderMarkdown(src) {
    const blocks = [];
    src = src.replace(/```(\w*)\r?\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push({ lang: lang, code: code.replace(/\r?\n$/, "") });
      return "WCBLK" + (blocks.length - 1) + "";
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
      const blockMatch = line.match(/^\s*WCBLK(\d+)\s*$/);
      if (blockMatch) {
        closeList();
        const b = blocks[+blockMatch[1]];
        html +=
          '<pre class="code" dir="ltr"' +
          (b.lang ? ' data-lang="' + escapeHtml(b.lang) + '"' : "") +
          "><code>" +
          escapeHtml(b.code) +
          "</code></pre>";
        continue;
      }
      if (/^\s*$/.test(line)) {
        closeList();
        continue;
      }
      let m;
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
    const node = el("div", "msg " + role);
    if (isRTL(text)) node.setAttribute("dir", "rtl");
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
    if (isRTL(text)) node.setAttribute("dir", "rtl");
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

  function addTool(name, input) {
    const wrap = el("div", "tool");
    const head = el("div", "tool-head");
    head.appendChild(el("span", "name", "🔧 " + name));
    const toggle = el("span", "toggle", "▸");
    head.appendChild(toggle);
    const body = el("div", "tool-body hidden");
    body.textContent = "input: " + JSON.stringify(input, null, 2);
    head.addEventListener("click", function () {
      body.classList.toggle("hidden");
      toggle.textContent = body.classList.contains("hidden") ? "▸" : "▾";
    });
    wrap.appendChild(head);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return { wrap: wrap, body: body };
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
        addLog("💭 " + msg.text);
        break;
      case "log":
        addLog(msg.text);
        break;
      case "toolStart":
        addTool(msg.name, msg.input);
        break;
      case "toolEnd": {
        const t = addTool(msg.name + (msg.isError ? " (error)" : ""), {});
        if (msg.isError) t.wrap.classList.add("error");
        t.body.classList.remove("hidden");
        t.body.textContent = "";
        if (msg.preview && msg.preview.diff) {
          t.body.appendChild(renderDiff(msg.preview.diff));
        } else {
          t.body.textContent = msg.output || "(no output)";
        }
        scrollToBottom();
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
        addLog("Started a new task.");
        break;
      case "focusInput":
        inputEl.focus();
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
