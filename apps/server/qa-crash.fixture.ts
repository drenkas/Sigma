import { join } from "node:path";
import { Qa, type QaHost } from "./qa-runs.js";
import { Storage } from "./storage.js";
// Starts a QA run on a static site, begins an approved click on a page that never returns, then waits to be SIGKILLed.
const [data, site] = process.argv.slice(2);
const host: QaHost = {
  verifiedCode: async () => ({}), assertDirectReady: async () => {}, snapshot: async () => ({ status: "idle" }),
  changes: async () => ({ cwd: site, sourceCwd: site, baseCommit: "", files: [], diff: "", omitted: 0, revision: "rev-crash" }),
  withPromptAdmission: (_id, action) => action({ check: () => {} }),
};
const storage = new Storage(join(data, "state.sqlite")), qa = new Qa(storage, host, data, async () => {});
await storage.call("addSession", { id: "session-1", cwd: site, file: "", model: "m", managerId: "session-1", creation: { source: "user", actor: "user", cause: "test", commandId: "c" } });
const run = await qa.create("session-1", crypto.randomUUID(), "index.html");
const approve = async () => true;
await qa.act("session-1", "agent-1", "navigate", { path: "/busy.html" }, approve);
const shot = JSON.parse(await qa.act("session-1", "agent-1", "screenshot", {}, approve));
console.log(`READY ${run.id}`);
await qa.act("session-1", "agent-1", "click", { selector: "#b", observationId: shot.observationId }, approve);
