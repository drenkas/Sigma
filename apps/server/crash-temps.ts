import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
// Startup sweep of Sigma-owned crash leftovers under DATA_DIR only. Runs while holding the data lease, after Storage recovery, before any run starts.
// Repository-side temps (.pi-apply-*, .pi-edit-*) are never touched: they live in user repositories and need inspection, not deletion.
const targets: Array<[string, RegExp]> = [["native-tmp", /^claude-[A-Za-z0-9]{6}$/], ["worker-merge-temp", /^merge-[A-Za-z0-9]{6}$/]];
const owned = (path: string) => { try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink() && (process.getuid === undefined || info.uid === process.getuid()); } catch { return false; } };
const noLinks = (path: string): boolean => { for (const name of readdirSync(path)) { const child = join(path, name), info = lstatSync(child); if (info.isSymbolicLink() || info.isDirectory() && !noLinks(child)) return false; } return true; };
export function sweepCrashTemps(dataDir: string): string[] {
    const removed: string[] = [];
    let base: string;
    try { base = realpathSync(dataDir); } catch { return removed; }
    for (const [folder, pattern] of targets) {
        const root = join(base, folder);
        try { if (!owned(root) || realpathSync(root) !== root) continue; } catch { continue; }
        let names: string[];
        try { names = readdirSync(root); } catch { continue; }
        for (const name of names) {
            const path = join(root, name);
            try {
                if (!pattern.test(name) || !owned(path)) continue;
                const real = realpathSync(path);
                if (real !== path || !real.startsWith(root + sep) || !noLinks(real)) continue;
                rmSync(real, { recursive: true, force: true });
                removed.push(real);
            }
            catch { }
        }
    }
    return removed;
}
