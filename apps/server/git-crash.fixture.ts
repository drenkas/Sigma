import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
const [data, id, marker] = process.argv.slice(2);
const storage = new Storage(join(data, "state.sqlite")), host = new PiHost(storage, data, async () => { });
await host.init();
await host.snapshot(id);
const original = storage.call.bind(storage);
storage.call = (async (op: string, args?: any) => { if (op === "gitSave" && args?.intent?.dispatch && args.intent.process?.quiescent) {
    writeFileSync(marker, "HEAD moved; index not published\n");
    process.kill(process.pid, "SIGKILL");
} return original(op, args); }) as any;
const tool = (host as any).active.get(id).session.getToolDefinition("git_commit");
const running = tool.execute("actual-crash-call", { message: "Crash once\n\nFrozen receipt" });
for (let i = 0; i < 300; i++) {
    const approval = (await host.snapshot(id)).approvals.find(a => a.status === "pending");
    if (approval) {
        await host.decide(id, approval.id, true);
        break;
    }
    await new Promise(r => setTimeout(r, 20));
}
await running;
throw new Error("Crash boundary was not reached");
