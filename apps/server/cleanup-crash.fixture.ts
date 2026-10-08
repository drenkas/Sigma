import { join } from "node:path";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
import { Cleanup } from "./cleanup.js";
const [data, commandId, digest] = process.argv.slice(2);
const storage = new Storage(join(data, "state.sqlite")), host = new PiHost(storage, data, async () => { });
await host.init();
await new Cleanup(storage, host, data).run(commandId, digest, true);
throw new Error("Cleanup was expected to hang until killed");
