import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { WorkerApiError } from "./contracts.js";

export type ServiceIdentity = { version: 1; installation: string; secret: string };
export async function readServiceIdentity(directory: string): Promise<ServiceIdentity> {
  const value = JSON.parse(await readFile(path.join(directory, "worker-auth.json"), "utf8")) as ServiceIdentity;
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.secret) || !/^[a-f0-9]{32}$/.test(value.installation))
    throw new Error("Invalid worker service identity.");
  return value;
}
export async function ensureServiceIdentity(directory: string): Promise<ServiceIdentity> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { return await readServiceIdentity(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const identity: ServiceIdentity = { version: 1, installation: randomBytes(16).toString("hex"), secret: randomBytes(32).toString("hex") };
  // Publish a complete synced file without overwriting another coordinator's identity.
  const target = path.join(directory, "worker-auth.json"), temporary = `${target}.${randomBytes(16).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(identity)); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return readServiceIdentity(directory); }
  finally { await unlink(temporary); }
  return identity;
}
export function authorizeService(request: IncomingMessage, identity: ServiceIdentity): void {
  const value = request.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${identity.secret}`), supplied = Buffer.from(value);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new WorkerApiError(401, "service_unauthorized", "Worker service authentication required.");
  if (request.headers["x-hosty-worker-installation"] !== identity.installation)
    throw new WorkerApiError(409, "installation_mismatch", "Worker installation does not match.");
}
