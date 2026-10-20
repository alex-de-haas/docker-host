import { createProviderService } from "./service.js";

const data = process.env.HOSTY_APP_DATA_DIR, cache = process.env.HOSTY_APP_CACHE_DIR, auth = process.env.HOSTY_WORKER_AUTH_DIR;
if (!data || !cache || !auth) throw new Error("Worker requires declared data, cache and service-auth storage.");
const mode = process.env.HOSTY_HARNESS_RUNTIME === "docker" ? "docker" : "native";
const mounts = Object.fromEntries((process.env.HOSTY_MOUNT_DEVELOPMENT ?? "").split(",").filter(Boolean).map(entry => {
  const equal = entry.indexOf("="); return [entry.slice(0, equal), entry.slice(equal + 1)];
}));
const service = await createProviderService({ data, cache, auth, mode, trees: mounts.trees, files: process.env.HOSTY_WORKER_FILES_DIR });
const port = Number(mode === "docker" ? process.env.PORT ?? 3401 : process.env.HOSTY_PORT_WORKER ?? process.env.PORT ?? 3401);
service.server.listen(port, mode === "native" ? "127.0.0.1" : "0.0.0.0", () => console.log(`Harness worker listening on :${port}`));
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; service.server.close(); void service.close().then(() => process.exit(0)).catch(() => process.exit(1)); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
