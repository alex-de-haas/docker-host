import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

// Serves the settings page's static export. `next build` emits plain HTML/JS into web/out-build,
// and this process serves it — so the page gets the standard component stack without the gateway
// gaining a second runtime (docs/features/app-ui-surfaces/plan.md).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/out-build");

const contentTypes = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
}));

/** Serves `pathname` from the export, or answers false so the caller can 404. */
export async function serveStaticSite(pathname: string, response: ServerResponse): Promise<boolean> {
  const relative = pathname === "/" || pathname === "/settings" || pathname === "/settings/"
    ? "index.html"
    : pathname.replace(/^\/+/, "");

  const resolved = path.resolve(root, relative);
  // Containment check before any filesystem call: a request is untrusted input, and `..` in a URL
  // path must not be able to read outside the export. Resolve-then-compare rather than string
  // matching, because only the resolved path answers the question actually being asked.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return false;
  }

  let target = resolved;
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      target = path.join(target, "index.html");
      await stat(target);
    }
  } catch {
    return false;
  }

  response.writeHead(200, {
    "content-type": contentTypes.get(path.extname(target)) ?? "application/octet-stream",
    // Hashed assets are immutable; documents must revalidate or an operator would keep seeing the
    // page the previous version served.
    "cache-control": pathname.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-store",
  });
  createReadStream(target).pipe(response);
  return true;
}
