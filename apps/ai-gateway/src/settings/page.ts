// The settings page, served by the gateway itself.
//
// Why it lives here rather than in Shell: the assistant is optional, removable and replaceable, so a
// settings page baked into Shell would make Shell know one provider's configuration schema. The
// platform already has the pattern — hosty.marketplace and hosty.telemetry get their sidebar entries
// purely from `ui.navigation` in their manifests — and observability was deliberately moved out of
// Shell into its own app for the same reason. Serving from this process costs nothing: the gateway
// already runs an HTTP server, and unlike telemetry there is no second runtime to split out.
//
// Hand-written HTML rather than a framework: the page is two controls and a list. Adding a build
// step and a UI toolchain to a headless Node app would be the largest thing in it, for a page that
// changes rarely.

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: Canvas; color: CanvasText;
  }
  main { max-width: 720px; margin: 0 auto; display: grid; gap: 28px; }
  h1 { font-size: 18px; margin: 0; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  p.hint { margin: 0 0 12px; opacity: .7; font-size: 13px; }
  textarea {
    width: 100%; min-height: 160px; padding: 10px; border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: transparent; color: inherit; font: inherit; resize: vertical;
  }
  .row {
    display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px;
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 8px;
  }
  .row + .row { margin-top: 8px; }
  .row .meta { flex: 1; min-width: 0; }
  .row .id { font-size: 12px; opacity: .65; word-break: break-all; }
  button {
    padding: 7px 14px; border-radius: 8px; font: inherit; cursor: pointer;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: color-mix(in srgb, CanvasText 8%, transparent); color: inherit;
  }
  button[disabled] { opacity: .5; cursor: default; }
  /* The shadcn switch shape, hand-written: this app has no React build, and adding a UI toolchain to
     a headless Node process for one page would be the largest thing in it. The checkbox stays the
     control — it carries the state, the focus ring and the keyboard behaviour — and is only visually
     replaced by the track and thumb, so nothing about accessibility depends on the CSS. */
  .switch { position: relative; display: inline-flex; flex: none; width: 40px; height: 22px; cursor: pointer; }
  .switch input {
    position: absolute; inset: 0; margin: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;
  }
  .switch .thumb {
    pointer-events: none; flex: 1; border-radius: 999px; transition: background-color .15s ease;
    background: color-mix(in srgb, CanvasText 22%, transparent);
  }
  .switch .thumb::after {
    content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
    background: Canvas; transition: transform .15s ease;
  }
  .switch input:checked + .thumb { background: color-mix(in srgb, CanvasText 70%, transparent); }
  .switch input:checked + .thumb::after { transform: translateX(18px); }
  /* Focus is drawn on the track because the input itself is transparent — without this, keyboard
     users would tab onto an invisible control. */
  .switch input:focus-visible + .thumb { outline: 2px solid Highlight; outline-offset: 2px; }
  .trust {
    padding: 6px 10px; border-radius: 8px; font: inherit; color: inherit;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: color-mix(in srgb, CanvasText 8%, transparent);
  }
  .trust[disabled] { opacity: .5; }
  .status { font-size: 13px; min-height: 1.4em; }
  .status[data-kind="error"] { color: #b3261e; }
  .empty { opacity: .7; font-size: 13px; }
  .banner {
    padding: 10px 12px; border-radius: 8px; font-size: 13px;
    border: 1px solid color-mix(in srgb, #d97706 45%, transparent);
    background: color-mix(in srgb, #d97706 12%, transparent);
  }
`;

// The page asks its embedder for a delegated token rather than holding a credential of its own:
// same posture as the chat panel, and it keeps the gateway out of the business of storing operator
// credentials. The handshake is the embedder slice of @hosty-sdk/app — Shell answers it for this
// app because it already mints these tokens to run the chat panel.
//
// The token is cached until it is nearly spent: it is good for minutes, and asking per request
// would send the embedder to Core on every save. A 401 drops it and marks the next request as a
// refresh, since an embedder that caches its own mints would otherwise keep answering with the
// token this API just refused. Without an embedder there is no way to get one at all, which the
// page says outright rather than rendering an empty form.
const SCRIPT = `
const state = { settings: null, harness: null, providers: [], discovery: "ok" };

// Every failure to obtain a token — no embedder, an embedder that does not grant this app one, a
// mint Core refused because the operator is not an administrator — leaves the page with the same
// silence, so one honest message names all three rather than guessing at which it was.
const NO_TOKEN =
  "No token from the embedder. Open this page from Hosty Shell, signed in as a host administrator.";

let grant = null;
// Set after a 401: the embedder may be caching a mint of its own, and only this page knows the
// token it was given came back refused.
let refused = false;

function token() {
  if (grant && grant.expiresAtMs - Date.now() > 30000) {
    return Promise.resolve(grant.value);
  }
  if (window.parent === window) {
    return Promise.reject(new Error(
      "This page holds no credential of its own — open the assistant settings from Hosty Shell."
    ));
  }

  return new Promise((resolve, reject) => {
    const wanted = "hosty:delegated-token";
    const request = refused
      ? { type: "hosty:request-delegated-token", refresh: true }
      : { type: "hosty:request-delegated-token" };
    function handler(event) {
      // Only the embedder is answering this: any other document sharing the postMessage party line
      // would be handing the page a token of its choosing.
      if (event.source !== window.parent) {
        return;
      }
      if (event.data && event.data.type === wanted && typeof event.data.token === "string") {
        done();
        const expiresAtMs = Date.parse(event.data.expiresAt);
        grant = { value: event.data.token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0 };
        refused = false;
        resolve(grant.value);
      }
    }
    function done() {
      clearTimeout(timer);
      clearInterval(retry);
      window.removeEventListener("message", handler);
    }
    const timer = setTimeout(() => {
      done();
      reject(new Error(NO_TOKEN));
    }, 8000);
    window.addEventListener("message", handler);
    window.parent.postMessage(request, "*");
    // Asked again until answered, because this page runs the moment its document does and an
    // embedder is under no obligation to have a listener attached by then — a single request lost
    // to that race would leave the page dead for the whole timeout. Answering is idempotent (the
    // embedder mints or reuses), so repeating costs nothing.
    const retry = setInterval(() => window.parent.postMessage(request, "*"), 500);
  });
}

async function api(path, init) {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init && init.body ? { "content-type": "application/json" } : {}), authorization: "Bearer " + (await token()) },
  });
  if (!response.ok) {
    if (response.status === 401) {
      // The cached token is spent or was never good enough; drop it and tell the embedder its own
      // copy is refused too, so the next attempt gets a fresh mint rather than the same credential
      // this route just rejected — the two clocks need not agree on "expired".
      grant = null;
      refused = true;
    }
    const body = await response.json().catch(() => null);
    throw new Error((body && body.message) || ("Request failed (" + response.status + ")."));
  }
  return response.json();
}

function say(text, kind) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.dataset.kind = kind || "";
}

function renderProviders() {
  const host = document.getElementById("providers");
  host.innerHTML = "";
  if (state.discovery !== "ok") {
    const warn = document.createElement("p");
    warn.className = "banner";
    warn.textContent = "Could not reach Core, so the app list could not be loaded. Providers you have already enabled are unchanged and still in effect.";
    host.append(warn);
    return;
  }
  if (state.providers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No installed app declares an MCP interface yet. Apps appear here once they do, switched off.";
    host.append(empty);
    return;
  }
  for (const provider of state.providers) {
    const row = document.createElement("div");
    row.className = "row";
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.textContent = provider.displayName || provider.appId;
    const id = document.createElement("div");
    id.className = "id";
    id.textContent = provider.appId + (provider.url ? " · " + provider.url : " · no reachable URL")
      + (provider.running ? "" : " · stopped");
    meta.append(name, id);
    // A switch, not a button. The button before it was labelled with the CURRENT state ("Enabled" /
    // "Disabled"), which is ambiguous in the way that matters: a control reading "Disabled" is equally
    // readable as "this is off" and as "click to disable", and the operator cannot tell which without
    // clicking. A switch has no such reading — its position is the state, and moving it is the action.
    const enabled = state.settings.mcpProviders[provider.appId] === true;
    const toggle = document.createElement("label");
    toggle.className = "switch";
    toggle.title = enabled
      ? "The assistant can call this app's MCP tools."
      : "The assistant cannot call this app's tools.";
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = enabled;
    toggleInput.setAttribute("aria-label", "Let the assistant use " + (provider.displayName || provider.appId) + "'s tools");
    const thumb = document.createElement("span");
    thumb.className = "thumb";
    toggle.append(toggleInput, thumb);
    toggleInput.addEventListener("change", async () => {
      // Both controls freeze until the save answers. The select's meaning depends on the switch's
      // value, so leaving it interactive mid-save lets the operator edit approval for a provider
      // that is in the middle of being turned off — a contradiction the re-render then races.
      toggleInput.disabled = true;
      trust.disabled = true;
      await save({ mcpProviders: { ...state.settings.mcpProviders, [provider.appId]: toggleInput.checked } });
    });

    // The second decision, and a different one: the switch above is whether this app may reach the
    // assistant at all; this is whether its own word about which tools are read-only is enough to skip
    // an approval. A select rather than a button for the same reason — it shows the chosen option as a
    // value, and the alternative as an option, instead of making one string do both jobs.
    const trust = document.createElement("select");
    trust.className = "trust";
    const trusted = state.settings.mcpAutoAllow[provider.appId] === true;
    for (const option of [
      { value: "ask", label: "Ask before every tool" },
      { value: "auto", label: "Run read-only tools unprompted" },
    ]) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      element.selected = option.value === (trusted ? "auto" : "ask");
      trust.append(element);
    }
    trust.title =
      "The app declares which of its tools are read-only. Choosing to run them unprompted means "
      + "trusting that declaration: a tool the app mislabels would then run without asking you.";
    // Meaningless while the app cannot reach the assistant at all, so it is not offered then.
    trust.disabled = !enabled;
    trust.setAttribute("aria-label", "Approval for " + (provider.displayName || provider.appId));
    trust.addEventListener("change", async () => {
      toggleInput.disabled = true;
      trust.disabled = true;
      await save({ mcpAutoAllow: { ...state.settings.mcpAutoAllow, [provider.appId]: trust.value === "auto" } });
    });

    row.append(meta, trust, toggle);
    host.append(row);
  }
}

async function save(patch) {
  try {
    const body = await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
    state.settings = body.settings;
    const live = state.harness && state.harness.capabilities && state.harness.capabilities.liveReconfigure;
    const immediate = patch.mcpProviders || patch.mcpAutoAllow;
    say(immediate && live ? "Applied to running sessions." : "Saved — applies to the next session.");
  } catch (error) {
    say(error.message, "error");
  } finally {
    // Re-rendered from confirmed state on EVERY outcome. The browser mutates a control the moment it
    // is used, so a failed save would otherwise leave the new value on screen while the persisted
    // policy still holds the old one — a select showing "Ask before every tool" over a policy that
    // still auto-allows is the worst lie this page could tell. On failure state.settings was never
    // updated, so this render is what puts the control back.
    renderProviders();
  }
}

async function load() {
  try {
    const body = await api("/api/settings");
    state.settings = body.settings;
    state.harness = body.harness;
    state.providers = body.providers || [];
    state.discovery = body.discovery || "ok";
    document.getElementById("prompt").value = state.settings.systemPrompt;
    document.getElementById("harness").textContent = state.harness.name;
    renderProviders();
    say("");
  } catch (error) {
    say(error.message, "error");
  }
}

document.getElementById("save-prompt").addEventListener("click", () => {
  void save({ systemPrompt: document.getElementById("prompt").value });
});
void load();
`;

export function renderSettingsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assistant settings</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <h1>Assistant settings</h1>

  <section>
    <h2>System prompt</h2>
    <p class="hint">
      Appended to the harness's own instructions — it never replaces your <code>CLAUDE.md</code>,
      your project settings or your skills. Applies to the next session: changing it mid-conversation
      would leave a transcript whose halves ran under different instructions.
    </p>
    <textarea id="prompt" placeholder="e.g. Prefer the hosty CLI over raw docker commands."></textarea>
    <p><button id="save-prompt" type="button">Save</button></p>
  </section>

  <section>
    <h2>MCP providers</h2>
    <p class="hint">
      Installed apps that expose an MCP interface. New apps arrive switched off on purpose: tool
      names and descriptions are text written by the app and land in the context of a model that has
      shell access on this host, so reaching one is a decision rather than a side effect of
      installing it.
    </p>
    <div id="providers"></div>
  </section>

  <section>
    <h2>Harness</h2>
    <p class="hint">Selected harness: <strong id="harness">…</strong>. Change it in the app's settings.</p>
  </section>

  <p class="status" id="status"></p>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
