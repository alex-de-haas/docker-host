import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fail } from "./storage.js";

/** Opaque continuations are authenticated metadata, never bearer authority to a source corpus. */
export class ExportCursors {
  private key: Promise<Buffer> | undefined;
  constructor(private readonly root: string) {}
  private secret(): Promise<Buffer> {
    return this.key ??= (async () => {
      const file = path.join(this.root, "cursor-key");
      await mkdir(this.root, { recursive: true });
      try { await writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const key = await readFile(file); if (key.length !== 32) throw new Error("Invalid history cursor signing key"); return key;
    })().catch(error => { this.key = undefined; throw error; });
  }
  async issue(scope: string, sequence: string): Promise<string> {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", await this.secret(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ version: 1, scope, sequence })), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }
  async read(scope: string, cursor: string): Promise<number> {
    try {
      if (typeof cursor !== "string" || cursor.length > 1024) throw new Error("Invalid cursor");
      const bytes = Buffer.from(cursor, "base64url");
      if (bytes.length < 29) throw new Error("Invalid cursor");
      const cipher = createDecipheriv("aes-256-gcm", await this.secret(), bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const value = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
      if (value.version !== 1 || value.scope !== scope || typeof value.sequence !== "string" || !/^[0-9]+$/.test(value.sequence) || !Number.isSafeInteger(Number(value.sequence))) throw new Error("Invalid cursor");
      return Number(value.sequence);
    } catch { return fail("rescan_required", "This cursor is unavailable or belongs to another source partition.", 410); }
  }
}
