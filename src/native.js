// Native layer for Nathan's Lift & Keto Log (Android).
// 1. Stands in for the claude.ai runtime (window.claude.use) so app.html runs unchanged:
//    db -> saved on the phone, sample -> Anthropic API with the user's own key,
//    downloads -> Android share sheet, user -> fixed local id.
// 2. Reads daily steps from Health Connect (Samsung Health syncs there).
// 3. Keeps the app current: downloads a newer app.html from GitHub Pages into
//    app storage and points the web view at it (Capacitor's live-update path),
//    so app changes arrive without reinstalling. A new APK resets to its bundle.
import Anthropic from "@anthropic-ai/sdk";
import { Capacitor, WebView } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { Health } from "capacitor-health";

const UPDATE_BASE = (typeof __UPDATE_BASE__ !== "undefined" && __UPDATE_BASE__) || "";
const SHELL_VERSION = (typeof __SHELL_VERSION__ !== "undefined" && __SHELL_VERSION__) || 1;
const MODEL = "claude-opus-5-5";

const K = { db: "lk-native-db", key: "lk-api-key", hc: "lk-hc-on", hcLast: "lk-hc-last" };
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  raw(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
  setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const isNative = Capacitor.isNativePlatform();
const appVersion = (html) => { const m = /<meta name="app-version" content="(\d+)">/.exec(html || ""); return m ? +m[1] : 0; };
const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- db: one local collection ---------- */
function makeDb() {
  let store = ls.get(K.db, {});
  const save = () => ls.set(K.db, store);
  const snap = () => ({ docs: Object.entries(store).map(([id, v]) => ({ id, data: () => v })) });
  return {
    collection() {
      return {
        doc(id) {
          return {
            async get() { return { id, exists: id in store, data: () => store[id] }; },
            async set(d) { store[id] = d; if (!save()) throw { code: "storage_full" }; },
            async delete() { delete store[id]; save(); },
          };
        },
        onSnapshot(cb) { setTimeout(() => cb(snap()), 0); return () => {}; },
      };
    },
  };
}

/* ---------- sample: Claude through the user's own API key ---------- */
function blobToB64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
}
function parseJson(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  throw { code: "invalid_json" };
}
function mapError(e) {
  if (e && e.code && !(e instanceof Error)) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { code: "bad_key" };
  if (e instanceof Anthropic.RateLimitError) return { code: "rate_limited" };
  if (e instanceof Anthropic.BadRequestError) {
    const m = String(e.message || "").toLowerCase();
    if (m.includes("credit")) return { code: "no_credit" };
    if (m.includes("image")) return { code: "image_rejected" };
    return { code: "error" };
  }
  if (e instanceof Anthropic.APIConnectionError) return { code: navigator.onLine ? "error" : "offline" };
  if (e instanceof Anthropic.APIError) return { code: e.status === 529 ? "rate_limited" : "error" };
  return { code: "error" };
}
async function callClaude(content, maxTokens) {
  const key = ls.raw(K.key).trim();
  if (!key) throw { code: "no_key" };
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
  try {
    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens || 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content }],
    });
    if (msg.stop_reason === "refusal") throw { code: "error" };
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  } catch (e) { throw mapError(e); }
}
const sample = {
  async json(prompt, opts = {}) {
    const content = [];
    for (const img of opts.images || []) {
      const blob = img instanceof Blob ? img : null; if (!blob) continue;
      content.push({ type: "image", source: { type: "base64", media_type: blob.type || "image/jpeg", data: await blobToB64(blob) } });
    }
    content.push({ type: "text", text: prompt + "\n\nReply with only the JSON object, no other text." });
    return parseJson(await callClaude(content));
  },
  async text(prompt) { return await callClaude([{ type: "text", text: prompt }]); },
};

/* ---------- downloads: write a file, open the share sheet ---------- */
const downloads = {
  async save({ filename, data }) {
    const path = String(filename || "export.txt").replace(/[^\w.\-]/g, "_");
    const text = typeof data === "string" ? data : JSON.stringify(data);
    await Filesystem.writeFile({ path, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    try { await Share.share({ title: path, files: [uri], dialogTitle: "Save your backup" }); }
    catch (e) { if (!/cancel/i.test(String(e && e.message))) throw e; }
  },
};

window.claude = {
  native: true,
  async use(name) {
    if (name === "db") return makeDb();
    if (name === "user") return { id: async () => "me" };
    if (name === "sample") return sample;
    if (name === "downloads") return downloads;
    return null; // mcp etc. are not available outside claude.ai
  },
};

/* ---------- Health Connect steps ---------- */
const within = (p, ms, code) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code }), ms))]);
const hc = {
  async available() { if (!isNative) return false; try { return !!(await within(Health.isHealthAvailable(), 10000, "hc_timeout")).available; } catch (e) { return false; } },
  async connect() {
    if (!(await hc.available())) { try { await Health.showHealthConnectInPlayStore(); } catch (e) {} throw { code: "hc_missing" }; }
    const r = await within(Health.requestHealthPermissions({ permissions: ["READ_STEPS"] }), 180000, "hc_timeout");
    const ok = JSON.stringify(r || {}).includes('"READ_STEPS":true');
    ls.set(K.hc, ok); if (!ok) throw { code: "hc_denied" };
    return true;
  },
  async sync() {
    if (!ls.get(K.hc, false) || !window.APP) return 0;
    if (APP.stepSync) { const n = await within(APP.stepSync(), 60000, "hc_timeout"); ls.set(K.hcLast, Date.now()); return n; }
    const end = new Date(); const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 13);
    const r = await within(Health.queryAggregated({ startDate: start.toISOString(), endDate: end.toISOString(), dataType: "steps", bucket: "day" }), 30000, "hc_timeout");
    let n = 0;
    for (const s of (r && r.aggregatedData) || []) {
      const raw = String(s.startDate || "");
      const date = /^\d{4}-\d\d-\d\d/.test(raw) ? raw.slice(0, 10) : APP.today();
      const steps = Math.round(+s.value || 0);
      if (steps > 0 && date <= APP.today() && (+APP.day(date).steps || 0) !== steps) { APP.saveSteps(date, steps); n++; }
    }
    ls.set(K.hcLast, Date.now());
    return n;
  },
};
let syncing = null;
function syncSteps(manual) {
  if (syncing) return syncing;
  syncing = hc.sync().then((n) => { if (manual) APP.toast(n ? `Steps updated for ${n} day${n > 1 ? "s" : ""}` : "Steps are up to date"); return n; })
    .catch((e) => { if (manual) APP.toast("Couldn't read steps. Check Health Connect permissions."); return 0; })
    .finally(() => { syncing = null; });
  return syncing;
}

/* ---------- updates ---------- */
let running = 0, latestShell = 0, staged = 0;
const injectNative = (html) => html.replace(/(<meta name="app-version" content="\d+">)/, '$1\n<script src="native.js"></script>');
async function checkUpdate(manual) {
  if (!UPDATE_BASE) { if (manual) APP.toast("Updates aren't set up in this build"); return; }
  try {
    const j = await (await fetch(UPDATE_BASE + "version.json?t=" + Date.now(), { cache: "no-store" })).json();
    latestShell = +j.shell || 0;
    if (+j.version > Math.max(running, staged) && isNative) {
      const html = await (await fetch(UPDATE_BASE + "app.html?t=" + Date.now(), { cache: "no-store" })).text();
      if (appVersion(html) === +j.version && html.includes("window.APP=")) {
        const nativeJs = await (await fetch("native.js", { cache: "no-store" })).text();
        const dir = "lk-www-" + j.version;
        await Filesystem.writeFile({ path: dir + "/index.html", data: injectNative(html), directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
        await Filesystem.writeFile({ path: dir + "/native.js", data: nativeJs, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
        const { uri } = await Filesystem.getUri({ path: dir, directory: Directory.Data });
        const path = decodeURIComponent(uri.replace(/^file:\/\//, ""));
        staged = +j.version;
        showBanner("An update is ready.", "Restart now", () => WebView.setServerBasePath({ path }));
      }
    } else if (manual) APP.toast(latestShell > SHELL_VERSION ? "There's a new app install, see Setup" : "You have the newest version");
    if (manual && document.getElementById("v-more") && !document.getElementById("v-more").hidden) APP.render();
  } catch (e) { if (manual) APP.toast("Couldn't check for updates. Are you online?"); }
}
async function keepUpdatePath() {
  // After a restart into a downloaded update, make it stick across app launches,
  // and tidy away older downloaded versions.
  try {
    const { path } = await WebView.getServerBasePath();
    if (path && /lk-www-\d+/.test(path)) await WebView.persistServerBasePath();
    const cur = (/lk-www-(\d+)/.exec(path || "") || [])[1];
    const { files } = await Filesystem.readdir({ path: "", directory: Directory.Data });
    for (const f of files || []) {
      const name = typeof f === "string" ? f : f.name;
      if (/^lk-www-\d+$/.test(name) && name !== "lk-www-" + cur) await Filesystem.rmdir({ path: name, directory: Directory.Data, recursive: true }).catch(() => {});
    }
  } catch (e) {}
}
function showBanner(text, label, fn) {
  let b = document.getElementById("nat-banner");
  if (!b) { b = document.createElement("div"); b.id = "nat-banner"; document.body.appendChild(b); }
  b.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(76px + max(env(safe-area-inset-bottom,0px),var(--safe-area-inset-bottom,0px)));z-index:50;background:#16213a;color:#f7f5f0;border:1px solid #9c7a34;border-radius:14px;padding:10px 12px;display:flex;gap:10px;align-items:center;justify-content:space-between;font:500 15px system-ui";
  b.innerHTML = `<span>${escH(text)}</span><button style="min-height:40px;background:#17707a;color:#ffffff;border:0;border-radius:10px;padding:8px 12px;font-weight:700">${escH(label)}</button>`;
  b.querySelector("button").onclick = fn;
}

/* ---------- Setup tab panel ---------- */
const NATIVE = {
  shell: SHELL_VERSION,
  get version() { return running; },
  setupHtml() {
    const hasKey = !!ls.raw(K.key).trim(); const on = ls.get(K.hc, false); const last = ls.get(K.hcLast, 0);
    return `
  <div class="panel">
    <div class="eyebrow">Samsung Health steps</div>
    <div class="small">${on ? `Connected. Steps fill in on their own each time you open the app${last ? ` (last read ${new Date(last).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})` : ""}.` : "Not connected yet. Connect once and your daily steps from your phone and watch fill in on their own."}</div>
    <div class="row" style="gap:8px">${on ? `<button id="n-sync">Sync steps now</button><button id="n-hcset">Health Connect settings</button>` : `<button class="primary" id="n-hc">Connect Samsung Health</button>`}</div>
    <div class="small muted">In Samsung Health, open Settings, then Health Connect, and make sure Steps is allowed to sync. Then tap Connect here and allow Steps.</div>
  </div>
  <div class="panel">
    <div class="eyebrow">Claude for photos and tips</div>
    <div class="small">${hasKey ? "Your Anthropic API key is saved on this phone." : "Add your Anthropic API key to read food photos, labels, ketone strips and get your daily plan."}</div>
    <label class="f">Anthropic API key<input id="n-key" type="password" autocomplete="off" placeholder="${hasKey ? "Saved (paste a new one to replace it)" : "sk-ant-…"}"></label>
    <div class="row" style="gap:8px"><button class="primary" id="n-keysave">Save key</button>${hasKey ? `<button id="n-keytest">Test it</button><button id="n-keydel">Remove</button>` : ""}</div>
    <div class="small muted">Get a key at console.anthropic.com under API Keys. Each photo costs about a cent or two from your Anthropic credit. The key never leaves this phone except to talk to Anthropic.</div>
  </div>
  <div class="panel">
    <div class="eyebrow">App</div>
    <div class="small">Version ${running}${latestShell > SHELL_VERSION ? ` · <b>A new app install is available.</b>` : ""}</div>
    <div class="row" style="gap:8px"><button id="n-upd">Check for updates</button>${latestShell > SHELL_VERSION && UPDATE_BASE ? `<button class="primary" id="n-apk">Get the new install</button>` : ""}</div>
  </div>`;
  },
  bindSetup(el) {
    const $ = (s) => el.querySelector(s);
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on("#n-hc", async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true; btn.textContent = "Opening Health Connect…";
      try { await hc.connect(); APP.toast("Connected to Samsung Health"); await syncSteps(true); }
      catch (e) {
        const c = e && e.code;
        APP.toast(c === "hc_missing" ? "Health Connect wasn't found. Install or update it, then try again"
          : c === "hc_timeout" ? "Health Connect didn't answer. Try again, or open Health Connect settings"
          : "Steps permission wasn't given. You can allow it in Health Connect settings");
      }
      APP.render();
    });
    on("#n-sync", async () => { await syncSteps(true); APP.render(); });
    on("#n-hcset", () => Health.openHealthConnectSettings().catch(() => {}));
    on("#n-keysave", () => {
      const v = $("#n-key").value.trim(); if (!v) { APP.toast("Paste your key first"); return; }
      if (!/^sk-ant-/.test(v)) { APP.toast("That doesn't look like an Anthropic key (starts with sk-ant-)"); return; }
      ls.setRaw(K.key, v); APP.toast("Key saved"); APP.render();
    });
    on("#n-keydel", () => { try { localStorage.removeItem(K.key); } catch (e) {} APP.toast("Key removed"); APP.render(); });
    on("#n-keytest", async (ev) => {
      const b = ev.currentTarget; b.disabled = true; b.textContent = "Testing…";
      try { const out = await sample.json('Respond with {"ok": true}'); APP.toast(out && out.ok ? "Your key works" : "Got an odd answer, but the key works"); }
      catch (e) { APP.toast({ bad_key: "That key was turned down", no_credit: "Your Anthropic account needs credit", offline: "You're offline", rate_limited: "Busy, try again in a minute" }[e && e.code] || "Couldn't reach Anthropic"); }
      b.disabled = false; b.textContent = "Test it";
    });
    on("#n-upd", () => checkUpdate(true));
    on("#n-apk", () => { location.href = UPDATE_BASE.replace(/\/$/, "") + "/install.html"; });
  },
};
window.NATIVE = NATIVE;

/* ---------- boot ---------- */
// This script runs in <head> before the app's own script, so window.claude is ready.
running = appVersion(document.documentElement.outerHTML.slice(0, 2000));
function ready() {
  if (!window.APP) return setTimeout(ready, 150);
  syncSteps(false);
  checkUpdate(false);
  if (isNative) keepUpdatePath();
  App.addListener("resume", () => { syncSteps(false); checkUpdate(false); });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(ready, 300));
else setTimeout(ready, 300);
