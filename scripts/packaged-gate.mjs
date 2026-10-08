// Packaged-artifact gates for the Sigma desktop build. Re-runnable:
//   node scripts/packaged-gate.mjs [--app <Sigma.app>] [--dmg <Sigma.dmg>] [--skip-launch]
// Evidence (JSON) is written to .scratch/packaged-gate-<ts>/. Never touches the real app-data dir:
// every server/app run uses SIGMA_QA=1 and a fresh absolute SIGMA_DATA_DIR under the evidence directory.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile, lstat } from "node:fs/promises";
import { createServer, connect } from "node:net";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_BINARY_NAME, PINNED_BINARY_SHA256 } from "../apps/server/cliproxy-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? resolve(args[i + 1]) : fallback; };
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const bundle = join(root, ".scratch/native-cargo-target/release/bundle");
const appPath = opt("--app", join(bundle, "macos/Sigma.app"));
const dmgPath = opt("--dmg", join(bundle, `dmg/Sigma_${version}_aarch64.dmg`));
const skipLaunch = args.includes("--skip-launch");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const out = join(root, `.scratch/packaged-gate-${stamp}`);
const runtimeOf = app => join(app, "Contents/Resources/sigma-runtime");
const PROXY_PORT = 8319; // DEFAULT_PROXY_PORT in cliproxy-provision.ts
const DRAIN_BOUND_MS = 20_000;

const sha = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
async function evidence(name, data) { await writeFile(join(out, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`); }
async function gate(id, title, fn) {
  const record = { id, title, status: "pass", checks: [], notes: [] };
  const check = (label, ok, detail) => { record.checks.push({ label, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); if (!ok) record.status = "fail"; return ok; };
  const t0 = Date.now();
  try { await fn(check, record); }
  catch (error) { record.status = record.status === "skip" ? "skip" : "fail"; record.error = String(error?.stack ?? error); }
  record.ms = Date.now() - t0;
  results.push(record);
  await evidence(`${id}`, record);
  console.log(`[${record.status.toUpperCase()}] ${id} ${title} (${record.ms} ms)`);
  for (const c of record.checks) if (!c.ok) console.log(`   FAIL: ${c.label} ${c.detail === undefined ? "" : JSON.stringify(c.detail)}`);
  if (record.error) console.log(`   ERROR: ${record.error.split("\n")[0]}`);
}

// ---- process helpers
function psTable() {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" });
  return r.stdout.split("\n").map(l => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] }));
}
function descendants(rootPid) {
  const table = psTable(), found = new Map(), queue = [rootPid];
  while (queue.length) { const p = queue.shift(); for (const e of table) if (e.ppid === p && !found.has(e.pid)) { found.set(e.pid, e); queue.push(e.pid); } }
  return [...found.values()];
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const portOpen = port => new Promise(res => { const s = connect({ host: "127.0.0.1", port }); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); s.setTimeout(500, () => { s.destroy(); res(false); }); });
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.once("error", rej); });
function leaseFree(dir) { return spawnSync("/usr/bin/perl", ["-e", 'open(F,"<",$ARGV[0]) or exit 2; flock(F,6) or exit 75; exit 0', dir]).status === 0; }

// ---- server runner (mirrors apps/desktop/src-tauri/src/main.rs: bin/node apps/server/main.js, cwd = runtime, stdin piped, PARENT_WATCH=1)
const owned = new Set();
async function startServer(runtime, dataDir, extraEnv = {}) {
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SIGMA_|PI_|NODE_OPTIONS$)/.test(k)));
  Object.assign(env, { SIGMA_PORT: String(port), SIGMA_DATA_DIR: dataDir, SIGMA_DEFAULT_WORKSPACE: join(out, "workspace"), SIGMA_PARENT_WATCH: "1", SIGMA_QA: "1", PI_CODING_AGENT_DIR: join(out, "pi-agent"), ...extraEnv });
  await mkdir(join(out, "workspace"), { recursive: true }); await mkdir(join(out, "pi-agent"), { recursive: true });
  const child = spawn(join(runtime, "bin/node"), ["apps/server/main.js"], { cwd: runtime, env, stdio: ["pipe", "pipe", "pipe"] });
  owned.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; }); child.stderr.on("data", d => { stderr += d; });
  const exited = new Promise(res => child.once("close", (code, signal) => res({ code, signal })));
  const t0 = Date.now();
  const expected = `Sigma API listening on http://127.0.0.1:${port}`;
  let ready = false, early;
  child.once("close", (code, signal) => { early = { code, signal }; });
  while (Date.now() - t0 < 45_000) { if (stdout.split("\n").some(l => l.trim() === expected)) { ready = true; break; } if (early) break; await sleep(100); }
  return { child, port, exited, ready, readyMs: Date.now() - t0, out: () => ({ stdout, stderr }), early: () => early };
}
async function stopServer(s) { // same signal as main.rs stop(): drop stdin -> EOF
  const t0 = Date.now();
  s.child.stdin.end();
  const timeout = new Promise(r => setTimeout(() => r("timeout"), DRAIN_BOUND_MS));
  const result = await Promise.race([s.exited, timeout]);
  return { ms: Date.now() - t0, result };
}
function api(port, method, path, headers = {}) {
  return new Promise((res, rej) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, timeout: 15_000 }, r => { let b = ""; r.on("data", d => { b += d; }); r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: b })); });
    req.on("error", rej); req.end();
  });
}
async function view(port) {
  const boot = await api(port, "POST", "/api/bootstrap", { Origin: `http://127.0.0.1:${port}` });
  const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  const r = await api(port, "GET", "/api/cliproxy", { Cookie: cookie });
  return { status: r.status, json: JSON.parse(r.body) };
}
async function proxyAction(port, action) { // POST /api/cliproxy/<action>; bootstrap cookie + Origin only (no command id needed)
  const origin = `http://127.0.0.1:${port}`;
  const boot = await api(port, "POST", "/api/bootstrap", { Origin: origin });
  const cookie = String(boot.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  const r = await api(port, "POST", `/api/cliproxy/${action}`, { Cookie: cookie, Origin: origin });
  return { status: r.status, json: JSON.parse(r.body) };
}
async function modes(dataDir) {
  const base = join(dataDir, "cliproxyapi"), res = {};
  for (const p of ["", "cliproxyapi", "cliproxyapi/auth", "cliproxyapi/bin"]) res[p || "."] = ((await stat(join(dataDir, p))).mode & 0o777).toString(8);
  for (const p of ["config.json", "connection.json", `bin/${PINNED_BINARY_NAME}`]) res[`cliproxyapi/${p}`] = ((await stat(join(base, p))).mode & 0o777).toString(8);
  return res;
}
async function walk(dir, acc = []) { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); acc.push(p); if (e.isDirectory()) await walk(p, acc); } return acc; }

async function main() {
  await mkdir(out, { recursive: true });
  const runtime = runtimeOf(appPath);
  const stagedManifest = JSON.parse(await readFile(join(root, ".scratch/desktop-runtime/MANIFEST.json"), "utf8"));
  const pre = { proxyPortBusy: await portOpen(PROXY_PORT), existingSigma: psTable().filter(p => /Sigma\.app\/Contents\/MacOS\/sigma-desktop/.test(p.command)).map(p => p.pid) };
  await evidence("preflight", { appPath, dmgPath, ...pre, drainBoundMs: DRAIN_BOUND_MS });
  if (pre.proxyPortBusy) throw new Error(`Port ${PROXY_PORT} (Sigma's private proxy port) is occupied; refusing to run gates that start an owned proxy`);

  // ---- a. DMG
  await gate("a-dmg", "DMG manifest + CLIProxyAPI hash", async (check, rec) => {
    const mount = join(out, "dmg-mount"); await mkdir(mount);
    const attach = spawnSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmgPath], { encoding: "utf8" });
    check("hdiutil attach", attach.status === 0, attach.stderr);
    if (attach.status !== 0) return;
    try {
      const mounted = runtimeOf(join(mount, "Sigma.app"));
      const manifest = JSON.parse(await readFile(join(mounted, "MANIFEST.json"), "utf8"));
      check("mounted MANIFEST equals staged MANIFEST", JSON.stringify(manifest) === JSON.stringify(stagedManifest));
      const bad = [];
      for (const [path, expected] of Object.entries(manifest.hashes)) if (await sha(join(mounted, path)).catch(() => "missing") !== expected) bad.push(path);
      check(`all ${Object.keys(manifest.hashes).length} manifest hashes match mounted files`, bad.length === 0, bad);
      const proxy = await sha(join(mounted, "resources/cliproxyapi", PINNED_BINARY_NAME)).catch(() => "missing");
      check("bundled CLIProxyAPI == pinned sha256", proxy === PINNED_BINARY_SHA256, proxy);
      check("MANIFEST cliproxyapi entry == pinned sha256", manifest.cliproxyapi?.[PINNED_BINARY_NAME] === PINNED_BINARY_SHA256);
      for (const f of ["CLIProxyAPI@8.0.13-LICENSE", "CLIProxyAPI@8.0.13-GO-THIRD-PARTY-NOTICES.txt"]) check(`notice staged: ${f}`, `package-license-files/${f}` in manifest.hashes);
      const notices = await readFile(join(mounted, "THIRD-PARTY-NOTICES.md"), "utf8");
      check("runtime THIRD-PARTY-NOTICES references Go notices", notices.includes("CLIProxyAPI@8.0.13-GO-THIRD-PARTY-NOTICES.txt") && !/NOT yet audited/.test(notices));
      const cs = spawnSync("codesign", ["--verify", "--deep", "--strict", join(mount, "Sigma.app")], { encoding: "utf8" });
      check("codesign --verify --deep --strict (mounted app)", cs.status === 0, cs.stderr);
      const dv = spawnSync("codesign", ["-dv", join(mount, "Sigma.app")], { encoding: "utf8" });
      rec.codesign = dv.stderr;
      check("ad-hoc signature", /Signature=adhoc/.test(dv.stderr));
      rec.dmgSha256 = await sha(dmgPath);
    } finally {
      const d = spawnSync("hdiutil", ["detach", mount], { encoding: "utf8" });
      check("hdiutil detach", d.status === 0, d.stderr);
      if (d.status === 0) await rm(mount, { recursive: true, force: true });
    }
  });

  // ---- b/c/e share a data dir for b+c; e uses its own
  const dataB = join(out, "data-bc");
  let firstView, firstStat;
  await gate("b-cold-start", "Cold start from bundled runtime", async (check, rec) => {
    const s = await startServer(runtime, dataB);
    try {
      check("Sigma API listening announced", s.ready, { readyMs: s.readyMs, stderr: s.out().stderr.slice(-500) });
      if (!s.ready) return;
      const v = await view(s.port); rec.view = v; firstView = v;
      check("GET /api/cliproxy 200", v.status === 200);
      check("proxy state == stopped (opt-in: nothing launched until Connect)", v.json.provider?.proxy?.state === "stopped", v.json.provider?.proxy);
      check("no proxy process or listener without opt-in", descendants(s.child.pid).length === 0 && !(await portOpen(PROXY_PORT)));
      const bin = join(dataB, "cliproxyapi/bin", PINNED_BINARY_NAME);
      check("binary copied to data dir with pinned hash", await sha(bin) === PINNED_BINARY_SHA256);
      firstStat = { mtimeMs: (await stat(bin)).mtimeMs, ino: (await stat(bin)).ino };
      rec.modes = await modes(dataB);
      const m = rec.modes;
      check("dir modes 0700", [".", "cliproxyapi", "cliproxyapi/auth", "cliproxyapi/bin"].every(k => m[k] === "700"), m);
      check("config/connection 0600, binary 0700", m["cliproxyapi/config.json"] === "600" && m["cliproxyapi/connection.json"] === "600" && m[`cliproxyapi/bin/${PINNED_BINARY_NAME}`] === "700", m);
      const auth = await readdir(join(dataB, "cliproxyapi/auth"));
      check("auth dir empty (no credentials copied)", auth.length === 0, auth);
      const files = (await walk(dataB)).map(p => p.slice(dataB.length + 1));
      rec.files = files;
      check("no credential-like files anywhere in data dir", !files.some(f => /(^|\/)(auth\.json|oauth|credentials|token)[^/]*$/i.test(f) || /\.(pem|key)$/.test(f)), files.filter(f => /auth|cred|token|oauth/i.test(f)));
      check("API key not echoed by view", !JSON.stringify(v.json).includes(JSON.parse(await readFile(join(dataB, "cliproxyapi/connection.json"), "utf8")).apiKey));
      rec.tree = descendants(s.child.pid).map(p => ({ pid: p.pid, pgid: p.pgid, command: p.command.slice(0, 160) }));
      const on = await proxyAction(s.port, "connect"); rec.connect = on;
      check("POST connect -> proxy state needs_login (owned, no auth)", on.status === 200 && on.json.provider?.proxy?.state === "needs_login", on.json.provider?.proxy);
      check("enabled.json written 0600 after connect", JSON.parse(await readFile(join(dataB, "cliproxyapi/enabled.json"), "utf8")).enabled === true && ((await stat(join(dataB, "cliproxyapi/enabled.json"))).mode & 0o777) === 0o600);
      const off = await proxyAction(s.port, "disconnect"); rec.disconnect = off;
      check("POST disconnect -> proxy stopped, listener gone", off.status === 200 && off.json.provider?.proxy?.state === "stopped");
      await sleep(500);
      check("proxy port free after disconnect", !(await portOpen(PROXY_PORT)));
      check("enabled.json cleared after disconnect", JSON.parse(await readFile(join(dataB, "cliproxyapi/enabled.json"), "utf8")).enabled === false);
    } finally {
      const st = await stopServer(s); rec.stop = st;
      check("clean exit on stdin EOF", st.result !== "timeout" && st.result.code === 0, st);
      rec.serverOutput = { ...s.out(), stdout: s.out().stdout.slice(-1000), stderr: s.out().stderr.slice(-1000) };
    }
  });

  const configHashBefore = async () => ({ config: await sha(join(dataB, "cliproxyapi/config.json")).catch(() => null), connection: await sha(join(dataB, "cliproxyapi/connection.json")).catch(() => null) });
  const cfg1 = await configHashBefore().catch(() => ({}));
  await gate("c-restart", "Restart on same data dir", async (check, rec) => {
    const s = await startServer(runtime, dataB);
    try {
      check("listening", s.ready, s.out().stderr.slice(-500));
      if (!s.ready) return;
      const v = await view(s.port); rec.view = v;
      check("same proxy state as cold start", v.json.provider?.proxy?.state === firstView?.json?.provider?.proxy?.state, { first: firstView?.json?.provider?.proxy?.state, now: v.json.provider?.proxy?.state });
      const bin = join(dataB, "cliproxyapi/bin", PINNED_BINARY_NAME), st = await stat(bin);
      check("binary hash unchanged", await sha(bin) === PINNED_BINARY_SHA256);
      check("binary not re-copied (mtime + inode unchanged)", st.mtimeMs === firstStat?.mtimeMs && st.ino === firstStat?.ino, { before: firstStat, after: { mtimeMs: st.mtimeMs, ino: st.ino } });
      const cfg2 = await configHashBefore();
      check("config + connection (API key) preserved", cfg1.config === cfg2.config && cfg1.connection === cfg2.connection);
    } finally { rec.stop = await stopServer(s); check("clean exit", rec.stop.result !== "timeout" && rec.stop.result.code === 0, rec.stop); }
  });

  await gate("d-degraded", "Bundled binary unavailable", async (check, rec) => {
    const copy = join(out, "runtime-nobinary");
    const c = spawnSync("cp", ["-cR", runtime, copy], { encoding: "utf8" }); // APFS clone
    check("runtime clone", c.status === 0, c.stderr);
    await rm(join(copy, "resources/cliproxyapi"), { recursive: true, force: true });
    const data = join(out, "data-d");
    const s = await startServer(copy, data);
    try {
      check("server still listens", s.ready, s.out().stderr.slice(-500));
      if (!s.ready) return;
      const v = await view(s.port); rec.view = v;
      const px = v.json.provider?.proxy;
      check("proxy state not_installed/degraded with reason", ["not_installed", "degraded"].includes(px?.state) && !!px?.reason, px);
      check("no binary in data dir", !(await lstat(join(data, "cliproxyapi/bin", PINNED_BINARY_NAME)).then(() => true, () => false)));
      check("no proxy process spawned", descendants(s.child.pid).length === 0 && !(await portOpen(PROXY_PORT)));
    } finally { rec.stop = await stopServer(s); check("clean exit", rec.stop.result !== "timeout" && rec.stop.result.code === 0, rec.stop); await rm(copy, { recursive: true, force: true }); }
  });

  await gate("e-quit-drain", "Quit drain with owned proxy running", async (check, rec) => {
    const data = join(out, "data-e");
    const s = await startServer(runtime, data);
    check("listening", s.ready, s.out().stderr.slice(-500));
    if (!s.ready) { await stopServer(s); return; }
    await proxyAction(s.port, "connect");
    const v = await view(s.port); rec.view = v;
    check("owned proxy running (state needs_login/ready, not borrowed)", ["needs_login", "ready"].includes(v.json.provider?.proxy?.state), v.json.provider?.proxy);
    check("proxy port open before quit", await portOpen(PROXY_PORT));
    const tree = descendants(s.child.pid);
    rec.before = tree.map(p => ({ pid: p.pid, pgid: p.pgid, command: p.command.slice(0, 160) }));
    check("watchdog + proxy processes present", tree.some(p => /cliproxy-watchdog/.test(p.command)) && tree.some(p => p.command.includes(PINNED_BINARY_NAME)), rec.before);
    check("lease held while running", !leaseFree(data));
    const st = await stopServer(s); rec.stop = st;
    check(`server exited within ${DRAIN_BOUND_MS} ms`, st.result !== "timeout" && st.result.code === 0, st);
    const pids = [s.child.pid, ...tree.map(p => p.pid)];
    await sleep(500);
    rec.survivors = pids.filter(alive);
    check("all server/watchdog/proxy processes gone", rec.survivors.length === 0, rec.survivors);
    const groups = [...new Set(tree.map(p => p.pgid))];
    check("no process left in owned process groups", groups.every(g => !psTable().some(p => p.pgid === g)), groups);
    check("proxy port free", !(await portOpen(PROXY_PORT)));
    check("data-dir lease released", leaseFree(data));
  });

  // ---- f. real .app via LaunchServices
  await gate("f-app-launch", "Launch actual .app via open -n and Quit", async (check, rec) => {
    if (skipLaunch) { rec.status = "skip"; rec.notes.push("--skip-launch"); return; }
    if (pre.existingSigma.length) { rec.status = "skip"; rec.notes.push(`Existing Sigma instance(s) ${pre.existingSigma} running; osascript quit by bundle id could hit the wrong instance`); return; }
    const data = join(out, "data-f");
    await mkdir(join(data, "cliproxyapi"), { recursive: true, mode: 0o700 });
    await writeFile(join(data, "cliproxyapi/enabled.json"), JSON.stringify({ enabled: true }), { mode: 0o600 }); // previous Connect click: autostart on
    const before = new Set(psTable().map(p => p.pid));
    const o = spawnSync("open", ["-n", "--env", "SIGMA_QA=1", "--env", `SIGMA_DATA_DIR=${data}`, "--env", `PI_CODING_AGENT_DIR=${join(out, "pi-agent")}`, "--stdout", join(out, "app.stdout"), "--stderr", join(out, "app.stderr"), appPath], { encoding: "utf8" });
    check("open -n", o.status === 0, o.stderr);
    let mine;
    for (let i = 0; i < 100 && !mine; i++) { await sleep(200); mine = psTable().find(p => !before.has(p.pid) && p.command.startsWith(join(appPath, "Contents/MacOS/sigma-desktop"))); }
    check("launched instance found", !!mine, mine);
    if (!mine) { rec.status = "fail"; return; }
    let server;
    for (let i = 0; i < 150 && !server; i++) { await sleep(200); server = descendants(mine.pid).find(p => /bin\/node apps\/server\/main\.js/.test(p.command)); }
    check("bundled node server child spawned (env reached app)", !!server);
    if (!server) { rec.notes.push("SIGMA_DATA_DIR env probably not applied; skipping quit check"); }
    let proxyUp = false;
    for (let i = 0; i < 100 && !proxyUp; i++) { await sleep(200); proxyUp = await portOpen(PROXY_PORT); }
    check("data dir is the QA scratch dir (provisioned binary present)", await lstat(join(data, "cliproxyapi/bin", PINNED_BINARY_NAME)).then(() => true, () => false));
    check("owned proxy up", proxyUp);
    const tree = [mine, ...descendants(mine.pid)]; rec.before = tree.map(p => ({ pid: p.pid, pgid: p.pgid, command: p.command.slice(0, 160) }));
    const t0 = Date.now();
    const q = spawnSync("osascript", ["-e", 'tell application id "dev.sigma.app" to quit'], { encoding: "utf8", timeout: 20_000 });
    rec.osascript = { status: q.status, stderr: q.stderr };
    check("osascript quit", q.status === 0, q.stderr);
    const deadline = Date.now() + DRAIN_BOUND_MS;
    while (Date.now() < deadline && tree.some(p => alive(p.pid))) await sleep(200);
    rec.quitMs = Date.now() - t0;
    rec.survivors = tree.map(p => p.pid).filter(alive);
    check(`app + children exited within ${DRAIN_BOUND_MS} ms`, rec.survivors.length === 0, rec.survivors);
    check("proxy port free", !(await portOpen(PROXY_PORT)));
    check("lease released", leaseFree(data));
    if (rec.survivors.length) { for (const pid of rec.survivors) { try { process.kill(pid, "SIGTERM"); } catch {} } rec.notes.push("Forced SIGTERM of survivors we launched"); }
  });
}

let fatal;
try { await main(); }
catch (error) { fatal = String(error?.stack ?? error); console.error(fatal); }
finally {
  for (const c of owned) if (c.exitCode === null && c.signalCode === null) { for (const d of descendants(c.pid)) { try { process.kill(d.pid, "SIGKILL"); } catch {} } try { c.kill("SIGKILL"); } catch {} }
  await evidence("summary", { out, fatal, gates: results.map(({ id, title, status, ms }) => ({ id, title, status, ms })) }).catch(() => {});
  console.log(`Evidence: ${out}`);
  process.exit(fatal || results.some(r => r.status === "fail") ? 1 : 0);
}
