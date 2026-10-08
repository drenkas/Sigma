import { join } from "node:path";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
const [data, id, commandId] = process.argv.slice(2);
const storage = new Storage(join(data, "state.sqlite")), host = new PiHost(storage, data, async () => { });
await host.init();
await host.snapshot(id);
await host.gitAction(id, "push", {}, commandId);
throw new Error("Push was expected to hang until killed");
