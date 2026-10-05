/** Shared by framework server adapters and plain Node apps. Never sends an app credential. */
export type AppAuthProtocol = 1 | 2;

export function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

const minimumProtocols = new Set<string>();
const discoveries = new Map<string, Promise<AppAuthProtocol | null>>();

export function appAuthProtocolMinimum(coreOrigin: string | null): 2 | null {
  try { return minimumProtocols.has(new URL(coreOrigin ?? "").origin) ? 2 : null; } catch { return null; }
}

function isOlderCoreVersion(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return false;
  for (const [index, suffix] of [[4, match[4]], [5, match[5]]] as const) {
    if (suffix && suffix.split(".").some(part => !/^[0-9A-Za-z-]+$/.test(part) || (index === 4 && /^0\d+$/.test(part)))) return false;
  }
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  return [major, minor, patch].every(Number.isSafeInteger) && major === 0 && minor < 120;
}

/** A 404 alone is insufficient: only an identified, older Core permits the old navigation. */
export async function resolveAppAuthProtocol(coreOrigin: string | null): Promise<AppAuthProtocol | null> {
  let origin: string;
  try {
    const parsed = new URL(coreOrigin ?? "");
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    origin = parsed.origin;
  } catch { return null; }
  const pending = discoveries.get(origin);
  if (pending) return pending;
  const operation = (async (): Promise<AppAuthProtocol | null> => {
    const request = (path: string) => fetch(new URL(path, origin), {
      cache: "no-store", redirect: "error", headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1_500),
    });
    try {
      const response = await request("/api/auth/apps/protocol");
      if (response.status === 200) {
        if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
        const body = await response.json().catch(() => null) as { version?: unknown } | null;
        if (body?.version !== 2) return null;
        minimumProtocols.add(origin);
        return 2;
      }
      if (response.status !== 404 || minimumProtocols.has(origin)) return null;
      const status = await request("/api/core/status");
      if (status.status !== 200) return null;
      if (!status.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
      const body = await status.json().catch(() => null) as { component?: unknown; status?: unknown; version?: unknown } | null;
      return body?.component === "hosty-core" && body.status === "running" && isOlderCoreVersion(body.version) ? 1 : null;
    } catch { return null; }
  })();
  discoveries.set(origin, operation);
  try { return await operation; } finally { discoveries.delete(origin); }
}
