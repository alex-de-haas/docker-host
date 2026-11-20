// Disposable provider for the managed child. Each speech operation validates its Hosty credential.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

const core = new URL("/api/internal/apps/" + encodeURIComponent(process.env.HOSTY_APP_ID) + "/provider/introspect", process.env.HOSTY_CORE_ORIGIN);
const evidence = process.env.HOSTY_SPEECH_FIXTURE_RECEIPTS;
async function serve(req, res) {
  const path = new URL(req.url, "http://fixture").pathname;
  const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === "/healthz") return json(200, { status: "healthy" });
  const kind = path.startsWith("/stt/") ? "speech-to-text" : "text-to-speech";
  const response = await fetch(core, { method: "POST", redirect: "error", headers: {
    "content-type": "application/json", authorization: "Bearer " + process.env.HOSTY_APP_SERVICE_TOKEN,
  }, body: JSON.stringify({ token: req.headers.authorization?.replace(/^Bearer /, ""), kind, key: "default" }) });
  if (!response.ok) return json(403, { code: "access_denied" });
  if (path === "/stt/capabilities") return json(200, { version: 1, ready: true, mediaTypes: ["audio/wav"], maxBytes: 3200044, maxDurationSeconds: 100, backend: "fixture" });
  if (path === "/tts/capabilities") return json(200, { version: 1, ready: true, mediaTypes: ["audio/pcm"], maxCharacters: 4000, backend: "fixture" });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 3200044) return json(413, { code: "too_large" });
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  if (path === "/stt/transcriptions" && data.toString("ascii", 0, 4) === "RIFF")
    return json(200, { text: "Проверка диктовки" });
  if (path !== "/tts/speech") return json(404, {});
  const { text } = JSON.parse(data);
  await appendFile(evidence, JSON.stringify({ textHash: createHash("sha256").update(text).digest("hex") }) + "\n");
  res.writeHead(200, { "content-type": "audio/pcm;rate=24000" });
  // Keep generating audio until the listener stops so cancellation reaches this provider.
  const pcm = Buffer.alloc(2400);
  res.write(pcm);
  const interval = setInterval(() => res.write(pcm), 50);
  const deadline = setTimeout(() => res.end(), 15000);
  res.once("close", () => { clearInterval(interval); clearTimeout(deadline); void appendFile(evidence, JSON.stringify({ cancelled: !res.writableEnded }) + "\n"); });
}
createServer((req, res) => { void serve(req, res).catch(() => res.destroy()); })
  .listen(Number(process.env.HOSTY_PORT_HTTP ?? 3529), "0.0.0.0");
