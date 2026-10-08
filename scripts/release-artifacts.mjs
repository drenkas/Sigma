// Prepares auto-update artifacts after `npm run desktop:build`. Uploads nothing.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => { console.error(`release:prepare: ${message}`); process.exit(1); };
const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, ".scratch/native-cargo-target");
const app = process.env.SIGMA_APP_PATH ? resolve(process.env.SIGMA_APP_PATH) : join(target, "release/bundle/macos/Sigma.app");
const keyPath = resolve(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(homedir(), ".tauri/sigma-updater.key"));
const config = JSON.parse(await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const version = config.version;
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail(`bad version in tauri.conf.json: ${version}`);
if (!existsSync(app) || !statSync(app).isDirectory()) fail(`Sigma.app not found at ${app}. Run \`npm run desktop:build\` first.`);
if (!existsSync(keyPath)) fail(`updater private key not found at ${keyPath}. Set TAURI_SIGNING_PRIVATE_KEY_PATH.`);
const tauri = join(root, "node_modules/.bin/tauri");
if (!existsSync(tauri)) fail("node_modules/.bin/tauri missing. Run `npm install`.");

const release = join(root, "release");
await mkdir(release, { recursive: true });
const name = `Sigma_${version}_aarch64.app.tar.gz`;
const archive = join(release, name);
// Archive root must be Sigma.app; COPYFILE_DISABLE keeps AppleDouble (._*) files out of the tarball.
const tar = spawnSync("tar", ["-czf", archive, "-C", dirname(app), "Sigma.app"], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
if (tar.status !== 0) fail("tar failed");
const sign = spawnSync(tauri, ["signer", "sign", "-f", keyPath, archive], { cwd: root, stdio: "inherit", env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" } });
if (sign.status !== 0) fail("tauri signer sign failed");
const signature = (await readFile(`${archive}.sig`, "utf8")).trim();
const manifest = {
  version,
  notes: process.env.SIGMA_RELEASE_NOTES || `Sigma ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature,
      url: `https://github.com/drenkas/Sigma/releases/download/v${version}/${name}`,
    },
  },
};
await writeFile(join(release, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const dmg = `Sigma_${version}_aarch64.dmg`;
console.log(`\nRelease tag: v${version}`);
console.log("Upload these files to the GitHub release (nothing was uploaded):");
for (const file of [dmg, name, "latest.json"]) console.log(`  release/${file}${existsSync(join(release, file)) ? "" : "   (MISSING: run desktop:build)"}`);
console.log(`(release/${name}.sig is embedded in latest.json; no need to upload it)`);
