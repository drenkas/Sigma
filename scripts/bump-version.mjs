// Bump or check the Sigma app version across every file that carries it.
//   node scripts/bump-version.mjs                      print version, verify all files agree (exit 1 otherwise)
//   node scripts/bump-version.mjs <major|minor|patch|X.Y.Z>
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = "apps/desktop/src-tauri";
const crate = (/^name\s*=\s*"([^"]+)"/m.exec(await readFile(join(root, tauri, "Cargo.toml"), "utf8")))[1];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const V = "(\\d+\\.\\d+\\.\\d+[^\"]*)";
// Each target: file + regex whose group 1 is the prefix, group 2 the version.
const targets = [
  ["package.json", /^(  "version": ")([^"]+)(")/m],
  ["package-lock.json", /^(  "version": ")([^"]+)(")/m],
  ["package-lock.json", /(^    "": \{[^}]*?"version": ")([^"]+)(")/m],
  [`${tauri}/tauri.conf.json`, /^(  "version": ")([^"]+)(")/m],
  [`${tauri}/Cargo.toml`, /(\[package\][^[]*?\nversion = ")([^"]+)(")/],
  [`${tauri}/Cargo.lock`, new RegExp(`(\\[\\[package\\]\\]\\nname = "${esc(crate)}"\\nversion = ")([^"]+)(")`)],
];

const files = new Map();
for (const [file] of targets) if (!files.has(file)) files.set(file, await readFile(join(root, file), "utf8"));
const found = targets.map(([file, re]) => {
  const m = re.exec(files.get(file));
  if (!m) { console.error(`version not found in ${file} (${re})`); process.exit(1); }
  return { file, version: m[2] };
});

const current = JSON.parse(files.get("package.json")).version;
const arg = process.argv[2];
if (!arg) {
  for (const f of found) console.log(`${f.version === current ? "ok  " : "DIFF"} ${f.version}  ${f.file}`);
  console.log(current);
  process.exit(found.every(f => f.version === current) ? 0 : 1);
}

const [maj, min, pat] = current.split(".").map(Number);
const next = arg === "major" ? `${maj + 1}.0.0` : arg === "minor" ? `${maj}.${min + 1}.0` : arg === "patch" ? `${maj}.${min}.${pat + 1}` : arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) { console.error(`usage: bump-version.mjs <major|minor|patch|X.Y.Z> (got "${arg}")`); process.exit(1); }
for (const [file, re] of targets) files.set(file, files.get(file).replace(re, (_, a, _v, c) => `${a}${next}${c}`));
for (const [file, text] of files) await writeFile(join(root, file), text);
console.log(`${current} -> ${next}`);
