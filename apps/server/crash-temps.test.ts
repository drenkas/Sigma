import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, symlink, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { sweepCrashTemps } from "./crash-temps.js";
import { PiHost } from "./pi-host.js";
import { Storage } from "./storage.js";
const scratch = resolve(import.meta.dirname, "../../.scratch");
process.env.PI_OFFLINE = "1";
process.env.SIGMA_DEMO = "1";
test("startup sweep removes only Sigma-owned crash temps under DATA_DIR and leaves repository temps and look-alikes", async () => {
    await mkdir(scratch, { recursive: true });
    const base = await mkdtemp(join(scratch, "crash-temps-")), data = join(base, "data"), repo = join(base, "repo"), outside = join(base, "outside");
    process.env.PI_CODING_AGENT_DIR = join(base, "agent");
    for (const dir of [join(data, "native-tmp", "claude-Ab12Cd", "nested"), join(data, "native-tmp", "keep-me"), join(data, "native-tmp", "claude-Sym123"), join(data, "native-tmp", "claude-Link12"), join(data, "worker-merge-temp", "merge-Zz9Yy8"), join(data, "other", "claude-Ab12Cd"), repo, outside])
        await mkdir(dir, { recursive: true });
    await writeFile(join(data, "native-tmp", "claude-Ab12Cd", "nested", "f"), "x");
    await writeFile(join(data, "native-tmp", "claude-Sym123", "f"), "x");
    await symlink(outside, join(data, "native-tmp", "claude-Sym123", "escape"));
    await symlink(outside, join(data, "native-tmp", "claude-Lnk123"));
    await writeFile(join(data, "native-tmp", "claude-file1"), "not a dir");
    await writeFile(join(outside, "precious"), "keep");
    await writeFile(join(repo, ".pi-apply-foo"), "user file");
    await writeFile(join(repo, ".pi-edit-merge-1"), "leftover");
    const storage = new Storage(join(data, "state.sqlite")), host = new PiHost(storage, data, async () => { });
    try {
        await host.init();
        assert.equal(existsSync(join(data, "native-tmp", "claude-Ab12Cd")), false);
        assert.equal(existsSync(join(data, "worker-merge-temp", "merge-Zz9Yy8")), false);
        assert.ok(existsSync(join(data, "native-tmp", "keep-me")), "unrelated sibling remains");
        assert.ok(existsSync(join(data, "native-tmp", "claude-Sym123")), "tree containing a symlink is not deleted");
        assert.ok(existsSync(join(data, "native-tmp", "claude-Lnk123")), "symlink entry is not followed or removed");
        assert.ok(existsSync(join(data, "native-tmp", "claude-file1")), "plain file with matching prefix remains");
        assert.ok(existsSync(join(data, "other", "claude-Ab12Cd")), "directories outside the swept roots remain");
        assert.equal(await readFile(join(outside, "precious"), "utf8"), "keep");
        assert.equal(await readFile(join(repo, ".pi-apply-foo"), "utf8"), "user file");
        assert.equal(await readFile(join(repo, ".pi-edit-merge-1"), "utf8"), "leftover");
        assert.ok((await stat(data)).isDirectory());
    }
    finally {
        await host.close();
        await storage.close();
    }
});
test("sweep refuses a native-tmp root that is a symlink", async () => {
    await mkdir(scratch, { recursive: true });
    const base = await mkdtemp(join(scratch, "crash-temps-")), data = join(base, "data"), elsewhere = join(base, "elsewhere");
    await mkdir(join(elsewhere, "claude-Ab12Cd"), { recursive: true });
    await mkdir(data);
    await symlink(elsewhere, join(data, "native-tmp"));
    assert.deepEqual(sweepCrashTemps(data), []);
    assert.ok(existsSync(join(elsewhere, "claude-Ab12Cd")));
});
