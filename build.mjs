// Bundles src/native.js into web/native.js (Android) and src/web.js into web/web.js
// (desktop web portal, published as the site's index.html), and writes web/version.json.
import { build } from "esbuild";
import fs from "fs";
const shell = +fs.readFileSync("shell-version.txt", "utf8").trim();
const app = fs.readFileSync("web/app.html", "utf8");
const m = /<meta name="app-version" content="(\d+)">/.exec(app);
if (!m) throw new Error("web/app.html is missing its app-version meta tag");
if (!app.includes("window.APP=")) throw new Error("web/app.html is missing the window.APP hook");
const base = process.env.UPDATE_BASE || "";
await build({
  entryPoints: ["src/native.js"], bundle: true, format: "iife", target: "chrome100", minify: true,
  outfile: "web/native.js", define: { __UPDATE_BASE__: JSON.stringify(base), __SHELL_VERSION__: String(shell) },
});
await build({
  entryPoints: ["src/web.js"], bundle: true, format: "iife", target: "es2020", minify: true, outfile: "web/web.js",
});
fs.writeFileSync("web/portal.html", app.replace(m[0], m[0] + '\n<script src="web.js"></script>'));
fs.writeFileSync("web/index.html", app.replace(m[0], m[0] + '\n<script src="native.js"></script>'));
fs.writeFileSync("web/version.json", JSON.stringify({ version: +m[1], shell }) + "\n");
console.log(`built native.js + web.js (update base: ${base || "none"}), app v${m[1]}, shell v${shell}`);
