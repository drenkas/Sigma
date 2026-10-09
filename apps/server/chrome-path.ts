import { homedir } from "node:os";
import { join } from "node:path";

export const chromeUserDataDir=(home=homedir())=>join(home,"Library/Application Support/Google/Chrome");
