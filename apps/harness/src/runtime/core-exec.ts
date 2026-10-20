import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createInterface } from "node:readline";
import { once } from "node:events";

// A child process preserves the provider adapters' ordinary pipe/exit/cancellation contract while
// the actual provider process runs in a Core-owned container. Secret configuration is env-only.
const url = new URL(process.env.HOSTY_WORKER_URL!);
const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.HOSTY_WORKER_TOKEN}`, "content-type": "application/x-ndjson" },
});
const fail = () => { process.stderr.write("Core agent transport disconnected; worker recovery may be required.\n"); process.exit(1); };
request.on("error", fail);
request.write(process.env.HOSTY_WORKER_REQUEST + "\n");
request.flushHeaders();
request.on("response", response => {
  if (response.statusCode !== 200) { response.resume(); fail(); return; }
  void (async () => {
    for await (const line of createInterface({ input: response })) {
      if (line.length > 262144) throw new Error("Frame too large.");
      const frame = JSON.parse(line) as { kind: string; data?: string; code?: number };
      if (frame.kind === "exit") {
        process.stdin.pause(); request.end();
        process.exitCode = frame.code ?? 1;
        response.destroy(); request.destroy();
        return;
      }
      if (frame.kind !== "stdout" && frame.kind !== "stderr") throw new Error("Invalid frame.");
      const output = frame.kind === "stdout" ? process.stdout : process.stderr;
      if (!output.write(Buffer.from(frame.data!, "base64"))) await once(output, "drain");
    }
    fail();
  })().catch(fail);
});
process.stdin.on("data", (chunk: Buffer) => {
  if (!request.write(JSON.stringify({ kind: "stdin", data: chunk.toString("base64") }) + "\n")) process.stdin.pause();
});
request.on("drain", () => process.stdin.resume());
process.stdin.on("end", () => request.end(JSON.stringify({ kind: "eof" }) + "\n"));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  request.destroy(); process.exit(1);
});
