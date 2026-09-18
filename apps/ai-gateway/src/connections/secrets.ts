/** Core's SDK server entry is Next/server-only; the gateway is plain node:http. */
export interface ConnectionSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export class CoreConnectionSecrets implements ConnectionSecrets {
  constructor(
    private readonly origin: string | null,
    private readonly appId: string,
    private readonly token: string | null,
  ) {}
  private async request(
    key: string,
    method: string,
    value?: string,
  ): Promise<Response> {
    if (!this.origin || !this.token)
      throw new Error(
        "Core secrets are unavailable. Run Gateway through Core.",
      );
    const response = await fetch(
      `${this.origin.replace(/\/$/, "")}/api/internal/apps/${encodeURIComponent(this.appId)}/secrets/${encodeURIComponent(key)}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        ...(value !== undefined ? { body: JSON.stringify({ value }) } : {}),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (method === "GET" && response.status === 404) {
      const body = (await response.clone().json()) as { code?: string };
      if (body.code === "app_secret_not_found") return response;
    }
    if (!response.ok)
      throw new Error(`Core secret storage failed (${response.status}).`);
    return response;
  }
  async get(key: string): Promise<string | null> {
    const response = await this.request(key, "GET");
    if (response.status === 404) return null;
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== "string")
      throw new Error("Invalid Core secret response.");
    return body.value;
  }
  async set(key: string, value: string): Promise<void> {
    await this.request(key, "PUT", value);
  }
  async delete(key: string): Promise<void> {
    await this.request(key, "DELETE");
  }
}
