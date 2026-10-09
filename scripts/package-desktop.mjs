import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_BINARY_NAME, PINNED_BINARY_SHA256 } from "../apps/server/cliproxy-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, ".scratch/desktop-runtime");
const emit = join(root, ".scratch/desktop-emit");
const nodeModules = await realpath(join(root, "node_modules"));
const runtimeRoots = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "fastify"];
const inside = (base, path) => path === base || path.startsWith(base + sep);
if (!inside(root, stage) || !inside(root, await realpath(dirname(stage)))) throw new Error(`Staging path escapes workspace: ${stage}`);
try { if ((await lstat(stage)).isSymbolicLink()) throw new Error(`Refusing symlink staging path: ${stage}`); }
catch (error) { if (error?.code !== "ENOENT") throw error; }

async function resolvePackage(parent, name) {
  const candidates = createRequire(join(parent, "package.json")).resolve.paths(name) ?? [];
  for (const base of candidates) {
    const alias = resolve(base, name);
    if (!inside(nodeModules, alias)) continue;
    try {
      const pkg = JSON.parse(await readFile(join(alias, "package.json"), "utf8"));
      if (pkg.name === name) {
        const path = await realpath(alias);
        if (!inside(nodeModules, path)) throw new Error(`Runtime dependency ${name} resolves outside workspace node_modules: ${path}`);
        return { path, alias };
      }
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  throw new Error(`Cannot resolve installed package ${name} from ${parent} inside workspace node_modules`);
}

const packages = new Map();
const aliases = new Map();
async function collect(name, from, required = true) {
  let resolved;
  try { resolved = await resolvePackage(from, name); }
  catch (error) {
    if (required) throw new Error(`Required runtime package ${name} is missing from ${from}`, { cause: error });
    return;
  }
  const { path, alias } = resolved;
  if (packages.has(path)) { aliases.set(alias, path); return; }
  const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  // Platform-restricted optional packages (e.g. @esbuild/linux-x64) are not part of this platform's runtime.
  const allows = (list, value) => !Array.isArray(list) || list.length === 0 || (list.some(item => !item.startsWith("!")) ? list.includes(value) : !list.includes(`!${value}`));
  if (!allows(pkg.os, process.platform) || !allows(pkg.cpu, process.arch)) return;
  aliases.set(alias, path);
  packages.set(path, pkg);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) await collect(dependency, path);
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) await collect(dependency, path, false);
  for (const dependency of Object.keys(pkg.peerDependencies ?? {})) {
    await collect(dependency, path, !pkg.peerDependenciesMeta?.[dependency]?.optional);
  }
}

for (const name of runtimeRoots) await collect(name, root);
if (!packages.size) throw new Error("No server runtime dependencies resolved");
for (const [source] of packages) {
  const destination = resolve(stage, relative(root, source));
  if (!inside(stage, destination)) throw new Error(`Runtime package destination escapes stage: ${destination}`);
}
for (const [alias, target] of aliases) {
  const destination = resolve(stage, relative(root, alias));
  const stagedTarget = resolve(stage, relative(root, target));
  if (!inside(stage, destination) || !inside(stage, stagedTarget)) throw new Error(`Dependency alias escapes stage: ${destination} -> ${stagedTarget}`);
}

// Fail closed: every production package needs a shipped license file or a supplemental file in packaging/licenses (name@version).
const LICENSE_FILE = /^(LICENSE|LICENCE|NOTICE|COPYING)([.-]|$)/i;
const supplementalDirectory = join(root, "packaging/licenses");
const supplemental = new Map();
try {
  for (const file of await readdir(supplementalDirectory)) {
    const match = /^(.+)-(\d[^-]*(?:-[^-]+)*)-LICENSE\.txt$/.exec(file);
    if (match) supplemental.set(`${match[1]}@${match[2]}`, file);
  }
} catch (error) { if (error?.code !== "ENOENT") throw error; }
const slugOf = pkg => pkg.name.replaceAll("/", "-");
const missingLicenses = [];
for (const [source, pkg] of packages) {
  const key = `${pkg.name}@${pkg.version ?? "unknown"}`;
  const shipped = (await readdir(source)).some(file => LICENSE_FILE.test(file));
  if (!shipped && !supplemental.has(`${slugOf(pkg)}@${pkg.version}`)) missingLicenses.push(key);
}
if (missingLicenses.length) throw new Error(`Missing license text for production packages (add packaging/licenses/<name>-<version>-LICENSE.txt):\n${[...new Set(missingLicenses)].sort().map(k => `  - ${k}`).join("\n")}`);

const ownerFile = join(stage, ".package-desktop-owner");
let stageOwned = false;
try { stageOwned = (await readFile(ownerFile, "utf8")) === "scripts/package-desktop.mjs\n"; } catch {}
if (stageOwned) await rm(stage, { recursive: true, force: true });
else {
  try { await stat(stage); throw new Error(`Refusing to replace unowned staging path: ${stage}`); }
  catch (error) { if (error instanceof Error && error.message.startsWith("Refusing")) throw error; if (error?.code !== "ENOENT") throw error; }
}
await mkdir(stage, { recursive: true });
await writeFile(ownerFile, "scripts/package-desktop.mjs\n");
await cp(join(emit, "apps/server"), join(stage, "apps/server"), { recursive: true });
await cp(join(emit, "packages/contracts"), join(stage, "packages/contracts"), { recursive: true });
await cp(join(root, "dist/web"), join(stage, "dist/web"), { recursive: true });
for (const file of ["storage-worker.mjs", "check-watchdog.mjs", "native-cli-watchdog.mjs", "qa-browser-watchdog.mjs", "cliproxy-config.mjs", "cliproxy-watchdog.mjs"]) {
  await cp(join(root, "apps/server", file), join(stage, "apps/server", file));
}
await mkdir(join(stage, "bin"), { recursive: true });
await cp(process.execPath, join(stage, "bin/node"));
await (await import("node:fs/promises")).chmod(join(stage, "bin/node"), 0o755);
await writeFile(join(stage, "package.json"), '{"name":"sigma-desktop-runtime","private":true,"type":"module"}\n');

// Optional pinned CLIProxyAPI binary: bundled from SIGMA_CLIPROXY_BINARY or, by default, the provisioned .data copy. Hash and licences are enforced.
let proxyBinary;
let proxyLicenseText;
let proxyGoNotices;
const isFile = async (path) => { try { return (await stat(path)).isFile(); } catch { return false; } };
const provisionedBinary = join(root, ".data/cliproxyapi", "bin", PINNED_BINARY_NAME);
let proxySource;
if (process.env.SIGMA_CLIPROXY_BINARY) {
  proxySource = resolve(process.env.SIGMA_CLIPROXY_BINARY);
  if (!(await isFile(proxySource))) throw new Error(`SIGMA_CLIPROXY_BINARY points to ${proxySource}, which does not exist. Unset it to use the provisioned ${provisionedBinary}, or point it at a real CLIProxyAPI 8.0.13 binary.`);
} else if (await isFile(provisionedBinary)) proxySource = provisionedBinary;
if (proxySource) {
  const bytes = await readFile(proxySource);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== PINNED_BINARY_SHA256) throw new Error(`${proxySource} does not match the pinned ${PINNED_BINARY_NAME} sha256`);
  const proxyLicense = join(supplementalDirectory, "CLIProxyAPI-8.0.13-LICENSE.txt");
  try { await stat(proxyLicense); } catch { throw new Error("Pinned CLIProxyAPI is staged but packaging/licenses/CLIProxyAPI-8.0.13-LICENSE.txt is missing"); }
  proxyLicenseText = proxyLicense;
  const goNotices = join(supplementalDirectory, "cliproxyapi-go/THIRD-PARTY-NOTICES.txt");
  try { if (!(await stat(goNotices)).isFile()) throw new Error("not a file"); }
  catch { throw new Error("Pinned CLIProxyAPI is staged but packaging/licenses/cliproxyapi-go/THIRD-PARTY-NOTICES.txt (Go dependency notices) is missing"); }
  proxyGoNotices = goNotices;
  const target = join(stage, "resources/cliproxyapi", PINNED_BINARY_NAME);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o755 });
  proxyBinary = digest;
  console.log(`CLIProxyAPI ${PINNED_BINARY_NAME} staged from ${proxySource} (sha256 ${digest}); MIT licence and Go dependency notices present.`);
} else console.log("No SIGMA_CLIPROXY_BINARY and no provisioned .data/cliproxyapi/bin binary: CLIProxyAPI not staged; first-run provisioning will report not_installed.");

const notices = ["# Third-party package notices", "", "Package license files are under package-license-files/.", ""];
const licenseDirectory = join(stage, "package-license-files");
await mkdir(licenseDirectory);
const nodeLicense = join(dirname(dirname(process.execPath)), "LICENSE");
await cp(nodeLicense, join(licenseDirectory, `node-v${process.versions.node}-LICENSE`));
const supplementalStaged = [];
for (const [source, pkg] of packages) {
  const target = resolve(stage, relative(root, source));
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    filter: candidate => {
      const path = relative(source, candidate);
      return path === "" || !path.split(sep).includes("node_modules");
    },
  });
  const version = pkg.version ?? "unknown";
  const slug = `${pkg.name.replaceAll("/", "-")}@${version}`;
  notices.push(`- ${pkg.name}@${version}: ${typeof pkg.license === "string" ? pkg.license : "license metadata unavailable"}`);
  let hasShipped = false;
  for (const file of await readdir(source)) {
    if (!LICENSE_FILE.test(file)) continue;
    await cp(join(source, file), join(licenseDirectory, `${slug}-${file}`));
    hasShipped = true;
  }
  const extra = supplemental.get(`${slugOf(pkg)}@${version}`);
  if (!hasShipped && extra) {
    await cp(join(supplementalDirectory, extra), join(licenseDirectory, `${slug}-LICENSE.supplemental.txt`));
    supplementalStaged.push(`package-license-files/${slug}-LICENSE.supplemental.txt`);
  }
}
for (const [alias, target] of aliases) {
  const destination = resolve(stage, relative(root, alias));
  const stagedTarget = resolve(stage, relative(root, target));
  if (destination === stagedTarget) continue;
  await mkdir(dirname(destination), { recursive: true });
  await (await import("node:fs/promises")).symlink(relative(dirname(destination), stagedTarget), destination, "dir");
}
if (proxyLicenseText) {
  await cp(proxyLicenseText, join(licenseDirectory, "CLIProxyAPI@8.0.13-LICENSE"));
  supplementalStaged.push("package-license-files/CLIProxyAPI@8.0.13-LICENSE");
  await cp(proxyGoNotices, join(licenseDirectory, "CLIProxyAPI@8.0.13-GO-THIRD-PARTY-NOTICES.txt"));
  supplementalStaged.push("package-license-files/CLIProxyAPI@8.0.13-GO-THIRD-PARTY-NOTICES.txt");
  notices.push("- CLIProxyAPI@8.0.13: MIT (binary only); statically linked Go dependency notices: package-license-files/CLIProxyAPI@8.0.13-GO-THIRD-PARTY-NOTICES.txt");
}
await writeFile(join(stage, "THIRD-PARTY-NOTICES.md"), `${notices.join("\n")}\n`);

const files = ["apps/server/main.js", "apps/server/data-lease.js", "apps/server/browser-use.js", "apps/server/chrome-path.js", "apps/server/internal-chrome.js", "apps/server/qa-browser-watchdog.mjs", "apps/server/cliproxy-process.js", "apps/server/cliproxy-provision.js", "apps/server/cliproxy-config.mjs", "apps/server/cliproxy-watchdog.mjs", "apps/server/storage-worker.mjs", "apps/server/check-watchdog.mjs", "apps/server/native-cli-watchdog.mjs", "packages/contracts/index.js", "dist/web/index.html", "bin/node", "THIRD-PARTY-NOTICES.md", ...supplementalStaged];
const hashes = {};
for (const path of files) {
  const bytes = await readFile(join(stage, path));
  hashes[path] = createHash("sha256").update(bytes).digest("hex");
}
await writeFile(join(stage, "MANIFEST.json"), `${JSON.stringify({ node: process.versions.node, packages: packages.size, hashes, ...(proxyBinary ? { cliproxyapi: { [PINNED_BINARY_NAME]: proxyBinary } } : {}) }, null, 2)}\n`);
console.log(`Desktop runtime staged at ${relative(root, stage)} (${packages.size} production packages, Node ${process.versions.node}).`);
