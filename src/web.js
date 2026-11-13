// Web portal layer for Nathan's Lift & Keto Log (desktop browser).
// Stands in for the claude.ai runtime the same way native.js does on Android:
// db -> this browser, sample -> Anthropic API with the user's own key,
// downloads -> a normal file download. The app's own cloud sign-in (Supabase)
// then syncs this browser with the phone. No Health Connect here: steps and
// watch water arrive from the phone through sync.
import { K, ls, appVersion, makeDb, sample } from "./shared.js";

const downloads = {
  async save({ filename, data }) {
    const name = String(filename || "export.txt").replace(/[^\w.\-]/g, "_");
    const text = typeof data === "string" ? data : JSON.stringify(data);
    const url = URL.createObjectURL(new Blob([text], { type: /\.json$/.test(name) ? "application/json" : "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};

window.claude = {
  native: true,
  async use(name) {
    if (name === "db") return makeDb();
    if (name === "user") return { id: async () => "me" };
    if (name === "sample") return sample;
    if (name === "downloads") return downloads;
    return null;
  },
};

let running = 0;
const NATIVE = {
  web: true,
  shell: 0,
  get version() { return running; },
  setupHtml() {
    const hasKey = !!ls.raw(K.key).trim();
    return `
  <div class="panel">
    <div class="eyebrow">Claude for photos and tips</div>
    <div class="small">${hasKey ? "Your Anthropic API key is set. It comes with your account, so your phone and this computer use the same one." : "Sign in above and the key from your phone comes along on its own. Or paste one here and it goes to your phone too."}</div>
    <label class="f">Anthropic API key<input id="n-key" type="password" autocomplete="off" placeholder="${hasKey ? "Saved (paste a new one to replace it)" : "sk-ant-…"}"></label>
    <div class="row" style="gap:8px"><button class="primary" id="n-keysave">Save key</button>${hasKey ? `<button id="n-keytest">Test it</button><button id="n-keydel">Remove</button>` : ""}</div>
    <div class="small muted">Keys come from console.anthropic.com under API Keys. Your key is kept with your account (only you can read it, once signed in) and is only sent to Anthropic. Signing out removes it from this browser.</div>
  </div>
  <div class="panel">
    <div class="eyebrow">Web version</div>
    <div class="small">Version ${running}. Steps and watch water come from your phone once it syncs. Reload the page to get the newest version.</div>
  </div>`;
  },
  bindSetup(el) {
    const $ = (s) => el.querySelector(s);
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
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
  },
};
window.NATIVE = NATIVE;
document.documentElement.classList.add("web");
running = appVersion(document.documentElement.outerHTML.slice(0, 2000));
