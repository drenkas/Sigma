import { join } from "node:path";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
const [data, source, id] = process.argv.slice(2);
const storage = new Storage(join(data, "state.sqlite")), host = new PiHost(storage, data, async () => { });
await host.init();
await host.create(source, "sigma-demo/offline", id, "code", { workspaceMode: "worktree" });
throw new Error("Allocation was expected to hang until killed");
