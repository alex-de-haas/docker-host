// Loaded only by the disposable Codex provider in the live history browser acceptance.
// Restrict the fixture to history response delivery. The provider still authorizes and serves each request.
import { channel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const policyFile = process.env.HOSTY_RANGE_TEST_POLICY;
function rules() {
  try { return JSON.parse(readFileSync(policyFile, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

channel("http.server.request.start").subscribe(({ request, response }) => {
  const url = new URL(request.url, "http://fixture.invalid");
  if (url.pathname.endsWith("/history/range")) {
    const session = url.searchParams.get("sessionId");
    const first = Number(url.searchParams.get("from"));
    const rule = rules()[session];
    if (!rule) return;
    if (rule.pageSize) {
      url.searchParams.set("limit", String(Math.min(Number(url.searchParams.get("limit") ?? 32), rule.pageSize)));
      request.url = url.pathname + url.search;
    }
    const end = response.end.bind(response);
    response.end = (...args) => {
      void (async () => {
        for (;;) {
          if (response.destroyed) return;
          const held = rules()[session]?.hold;
          if (!held?.some(([lo, hi]) => first >= lo && first <= hi)) break;
          await wait(30);
        }
        end(...args);
      })().catch(() => response.destroy());
      return response;
    };
  }
  if (url.pathname.endsWith("/history/live")) {
    const write = response.write.bind(response);
    response.write = (chunk, ...args) => {
      // Redeliver the same provider event ID and bytes, as a reconnecting client may observe.
      if (typeof chunk === "string" && chunk.includes('"message.completed"') && chunk.includes("GAP-CHECK-") && chunk.includes("-DUPLICATE")) write(chunk);
      return write(chunk, ...args);
    };
  }
});
