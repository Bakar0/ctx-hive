import { join } from "node:path";
import { hiveRoot } from "../../ctx/store.ts";

export const AGENT_MODEL = "sonnet";
export const AGENT_TOOLS = ["Bash", "Read", "Glob", "Grep"];
export const LOGS_DIR = join(hiveRoot(), "logs");
