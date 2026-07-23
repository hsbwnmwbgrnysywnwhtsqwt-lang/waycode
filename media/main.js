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

  function addMessage(role, text) {
    const node = el("div", "msg " + role, text);
    messagesEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  function addLog(text) {
    messagesEl.appendChild(el("div", "log", text));
    scrollToBottom();
  }

  function renderDiff(diff) {
    const pre = el("pre");
    diff.split("\n").forEach((line) => {
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
    head.addEventListener("click", () => {
      body.classList.toggle("hidden");
      toggle.textContent = body.classList.contains("hidden") ? "▸" : "▾";
    });
    wrap.appendChild(head);
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return { wrap, body };
  }

  function addApproval(id, preview) {
    const wrap = el("div", "approval");
    wrap.appendChild(el("div", "title", "⚠️ Approval required: " + preview.title));
    if (preview.diff) {
      wrap.appendChild(renderDiff(preview.diff));
    } else if (preview.detail) {
      const pre = el("pre");
      pre.textContent = preview.detail;
      wrap.appendChild(pre);
    }
    const actions = el("div", "approval-actions");
    const approve = el("button", "primary", "Approve");
    const reject = el("button", "", "Reject");
    const finish = (approved) => {
      vscode.postMessage({ type: "approval", id, approved });
      approve.disabled = reject.disabled = true;
      wrap.appendChild(el("div", "log", approved ? "✔️ Approved" : "✖️ Rejected"));
    };
    approve.addEventListener("click", () => finish(true));
    reject.addEventListener("click", () => finish(false));
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
    vscode.postMessage({ type: "send", text });
    inputEl.value = "";
  }

  sendBtn.addEventListener("click", send);
  cancelBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  newTaskBtn.addEventListener("click", () => vscode.postMessage({ type: "newTask" }));

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener("message", (event) => {
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
