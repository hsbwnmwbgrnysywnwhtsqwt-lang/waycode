// @ts-check
// WayCode settings page — vanilla JS, CSP-safe.
(function () {
  const vscode = acquireVsCodeApi();
  const formEl = document.getElementById("form");
  let data = null;

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function section(title, desc) {
    const s = el("section", "card");
    s.appendChild(el("h2", null, title));
    if (desc) s.appendChild(el("p", "desc", desc));
    return s;
  }

  function row(labelText, control) {
    const r = el("div", "row");
    const l = el("label", "row-label", labelText);
    r.appendChild(l);
    r.appendChild(control);
    return r;
  }

  function select(options, value) {
    const sel = el("select");
    options.forEach(function (o) {
      const opt = el("option", null, o.label);
      opt.value = o.value;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  function textInput(value, placeholder) {
    const i = el("input");
    i.type = "text";
    i.value = value || "";
    if (placeholder) i.placeholder = placeholder;
    return i;
  }

  function checkbox(checked) {
    const i = el("input");
    i.type = "checkbox";
    i.checked = Boolean(checked);
    return i;
  }

  function providerOptions(includeDefault) {
    const opts = data.providers.map(function (p) {
      return { value: p.id, label: p.label + (p.requiresApiKey ? " (key)" : "") };
    });
    if (includeDefault) opts.unshift({ value: "", label: "Same as main provider" });
    return opts;
  }

  // A model field: dropdown of Ollama models when provider is ollama, else text.
  function modelField(provider, value) {
    if (provider === "ollama" && data.ollamaModels.length) {
      const opts = data.ollamaModels.map(function (m) {
        return { value: m, label: m };
      });
      if (value && data.ollamaModels.indexOf(value) === -1) opts.unshift({ value: value, label: value });
      return select(opts, value);
    }
    return textInput(value, "model id");
  }

  function render() {
    formEl.innerHTML = "";

    // General
    const gen = section("General", "The default provider and model when multi-agent is off.");
    const providerSel = select(providerOptions(false), data.provider);
    const modelWrap = el("div");
    let modelCtl = modelField(data.provider, data.model);
    modelWrap.appendChild(modelCtl);
    providerSel.addEventListener("change", function () {
      modelWrap.innerHTML = "";
      modelCtl = modelField(providerSel.value, "");
      modelWrap.appendChild(modelCtl);
    });
    gen.appendChild(row("Provider", providerSel));
    gen.appendChild(row("Model", modelWrap));
    const langSel = select(
      data.languages.map(function (l) {
        return { value: l, label: l === "auto" ? "Auto (match me)" : l };
      }),
      data.language
    );
    gen.appendChild(row("Reply language", langSel));
    formEl.appendChild(gen);

    // Multi-agent
    const ma = section(
      "Multi-agent roles",
      "A language bot talks to you (e.g. in Hebrew) and a coder bot writes the code — each on its own model."
    );
    const maToggle = checkbox(data.multiAgent);
    ma.appendChild(row("Enable multi-agent", maToggle));

    function roleBlock(roleKey, title) {
      const wrap = el("div", "role");
      wrap.appendChild(el("h3", null, title));
      const r = data.roles[roleKey];
      const provSel = select(providerOptions(true), r.provider);
      const mWrap = el("div");
      let mCtl = modelField(r.provider, r.model);
      mWrap.appendChild(mCtl);
      provSel.addEventListener("change", function () {
        mWrap.innerHTML = "";
        mCtl = modelField(provSel.value, "");
        mWrap.appendChild(mCtl);
      });
      wrap.appendChild(row("Provider", provSel));
      wrap.appendChild(row("Model", mWrap));
      wrap._get = function () {
        return { provider: provSel.value, model: mCtl.value };
      };
      return wrap;
    }
    const commBlock = roleBlock("communicator", "🗣️ Communicator (talks to you)");
    const coderBlock = roleBlock("coder", "👨‍💻 Coder (writes code)");
    ma.appendChild(commBlock);
    ma.appendChild(coderBlock);
    formEl.appendChild(ma);

    // Approval
    const ap = section("Approvals", "What the agent may do without asking. Reads are safe; edits and commands change your files.");
    const apReads = checkbox(data.approval.reads);
    const apEdits = checkbox(data.approval.fileEdits);
    const apCmds = checkbox(data.approval.commands);
    ap.appendChild(row("Auto-approve reads", apReads));
    ap.appendChild(row("Auto-approve file edits", apEdits));
    ap.appendChild(row("Auto-approve commands", apCmds));
    formEl.appendChild(ap);

    // Endpoints
    const ep = section("Endpoints", "Local Ollama server and optional OpenAI-compatible base URL.");
    const ollamaUrl = textInput(data.ollamaBaseUrl, "http://localhost:11434");
    const openaiUrl = textInput(data.openaiBaseUrl, "(default) https://api.openai.com/v1");
    ep.appendChild(row("Ollama base URL", ollamaUrl));
    ep.appendChild(row("OpenAI base URL", openaiUrl));
    formEl.appendChild(ep);

    // API keys
    const keys = section("API keys", "Stored securely in VS Code Secret Storage. Ollama and Claude CLI need no key.");
    data.providers
      .filter(function (p) {
        return p.requiresApiKey;
      })
      .forEach(function (p) {
        const wrap = el("div", "key-row");
        const status = el("span", "key-status " + (data.keys[p.id] ? "set" : "unset"), data.keys[p.id] ? "✓ set" : "not set");
        const setBtn = el("button", "small", data.keys[p.id] ? "Update" : "Set key");
        setBtn.addEventListener("click", function () {
          vscode.postMessage({ type: "setKey", provider: p.id });
        });
        wrap.appendChild(status);
        if (data.keys[p.id]) {
          const clr = el("button", "small ghost", "Clear");
          clr.addEventListener("click", function () {
            vscode.postMessage({ type: "clearKey", provider: p.id });
          });
          wrap.appendChild(clr);
        }
        wrap.appendChild(setBtn);
        keys.appendChild(row(p.label, wrap));
      });
    formEl.appendChild(keys);

    // Save bar
    const bar = el("div", "savebar");
    const saveBtn = el("button", "primary", "Save settings");
    saveBtn.addEventListener("click", function () {
      vscode.postMessage({
        type: "save",
        data: {
          provider: providerSel.value,
          model: modelCtl.value,
          language: langSel.value,
          multiAgent: maToggle.checked,
          roles: { communicator: commBlock._get(), coder: coderBlock._get() },
          approval: { reads: apReads.checked, fileEdits: apEdits.checked, commands: apCmds.checked },
          ollamaBaseUrl: ollamaUrl.value,
          openaiBaseUrl: openaiUrl.value,
        },
      });
    });
    bar.appendChild(saveBtn);
    formEl.appendChild(bar);
  }

  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "init") {
      data = e.data.data;
      render();
    }
  });

  vscode.postMessage({ type: "ready" });
})();
