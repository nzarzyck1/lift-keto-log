// Shared by the Android app (native.js) and the web portal (web.js):
// local storage helpers, the local db, and Claude through the user's own API key.
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";
export const K = { db: "lk-native-db", key: "lk-api-key", hc: "lk-hc-on", hcLast: "lk-hc-last" };
export const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  raw(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
  setRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
export const appVersion = (html) => { const m = /<meta name="app-version" content="(\d+)">/.exec(html || ""); return m ? +m[1] : 0; };
export const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- db: one local collection ---------- */
export function makeDb() {
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
export const sample = {
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

