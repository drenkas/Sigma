import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "node_modules/.bin/tauri");
const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, ".scratch/native-cargo-target");
const config = JSON.parse(await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const environment = { ...process.env, CARGO_TARGET_DIR: target };
// A shipped build must carry the pinned CLIProxyAPI: without it the app reports not_installed and only the packaged gate notices.
const manifest = JSON.parse(await readFile(join(root, ".scratch/desktop-runtime/MANIFEST.json"), "utf8"));
if (!manifest.cliproxyapi) {
  console.error("CLIProxyAPI is not staged in .scratch/desktop-runtime, so this build would ship without the proxy. Provision .data/cliproxyapi/bin/CLIProxyAPI-8.0.13 (start Sigma from source once) or set SIGMA_CLIPROXY_BINARY to a CLIProxyAPI 8.0.13 binary, then run npm run desktop:build again.");
  process.exit(1);
}
const build = spawnSync(tauri, ["build", "--bundles", "app"], {
  cwd: root,
  env: environment,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const app = join(target, "release/bundle/macos/Sigma.app");
const dmgDirectory = join(target, "release/bundle/dmg");
// Ad-hoc signing only (no Developer ID, no notarization). Seal the bundle itself without re-signing nested
// executables: the bundled CLIProxyAPI is pinned by sha256 and bin/node is listed in MANIFEST.json, so their bytes must not change.
for (const args of [["--force", "--sign", "-", app], ["--verify", "--strict", "--verbose=2", app]]) {
  const result = spawnSync("codesign", args, { cwd: root, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const staging = join(root, `.scratch/native-dmg-stage-${process.pid}`);
const owner = join(staging, ".sigma-dmg-owner");
const expectedOwner = "scripts/build-desktop.mjs\n";
try {
  await readFile(owner, "utf8");
  throw new Error(`Refusing existing DMG staging directory: ${staging}`);
} catch (error) { if (error?.code !== "ENOENT") throw error; }
await mkdir(staging, { recursive: false });
await writeFile(owner, expectedOwner);
await cp(app, join(staging, "Sigma.app"), { recursive: true });
await symlink("/Applications", join(staging, "Applications"));
await mkdir(dmgDirectory, { recursive: true });
const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
const output = join(dmgDirectory, `Sigma_${config.version}_${architecture}.dmg`);
const image = spawnSync("hdiutil", ["create", "-volname", "Sigma", "-srcfolder", staging, "-ov", "-format", "UDZO", "-imagekey", "zlib-level=9", output], { cwd: root, env: environment, stdio: "inherit" });
if (image.error) throw image.error;
if (image.status !== 0) process.exit(image.status ?? 1);
const releaseDirectory = join(root, "release");
await mkdir(releaseDirectory, { recursive: true });
await copyFile(output, join(releaseDirectory, `Sigma_${config.version}_${architecture}.dmg`));
console.log(`DMG ready: release/Sigma_${config.version}_${architecture}.dmg`);
process.exit(0);
