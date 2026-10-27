import { AssistantClient } from "@hosty-sdk/app/assistant";
import { ProviderError, type AppPermissionState, type ProviderDescriptor, type ProviderInvocation, type ProviderKind, type SpeechCapabilities, type SpeechResult, type TranslationRequest, type TranslationResult, type TranslationCapabilities } from "@hosty-sdk/app/providers";

export type ProviderServerOptions = {
  appId?: string; coreOrigin?: string; serviceToken?: string;
  /** The consumer's deployment topology; endpoints on Core loopback must be reached through its host. */
  runningInContainer?: boolean;
};

/** Server-only provider client. Its app service token must never be sent to a browser or provider. */
export class ProviderClient {
  private readonly appId: string;
  private readonly core: URL;
  private readonly service: string;
  private readonly container: boolean;
  constructor(options: ProviderServerOptions = {}) {
    this.appId = options.appId ?? process.env.HOSTY_APP_ID ?? "";
    this.core = new URL(options.coreOrigin ?? process.env.HOSTY_CORE_ORIGIN ?? "http://127.0.0.1:7070");
    this.service = options.serviceToken ?? process.env.HOSTY_APP_SERVICE_TOKEN ?? "";
    this.container = options.runningInContainer ?? process.env.HOSTY_RUNTIME_TYPE === "docker";
    if (!this.appId || !this.service) throw new ProviderError("hosty_misconfigured", "Hosty app credentials are not configured.", 503);
  }
  private async coreRequest<T>(suffix: string, body?: unknown, signal?: AbortSignal, userToken?: string): Promise<T> {
    const response = await fetch(new URL(`/api/internal/apps/${encodeURIComponent(this.appId)}${suffix}`, this.core), {
      method: body === undefined ? "GET" : "POST", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${this.service}`, "content-type": "application/json", ...(userToken ? { "X-Hosty-User-Token": userToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return read<T>(response);
  }
  permissions(signal?: AbortSignal): Promise<AppPermissionState> { return this.coreRequest("/permissions", undefined, signal); }
  async list(kind: ProviderKind, signal?: AbortSignal): Promise<ProviderDescriptor[]> {
    return (await this.coreRequest<{ providers: ProviderDescriptor[] }>(`/providers/${kind}`, undefined, signal)).providers;
  }
  private async connect(provider: Pick<ProviderDescriptor, "appId" | "kind" | "key"> & { installationId?: string | null }, signal?: AbortSignal, userToken?: string) {
    const issued = await this.coreRequest<{ token: string; provider: ProviderDescriptor }>(`/providers/${provider.kind}/token`,
      { providerAppId: provider.appId, key: provider.key }, signal, userToken);
    if (issued.provider.version !== 1 || !issued.provider.url) throw new ProviderError("provider_incompatible", "This provider does not support interface version 1.", 409);
    if (provider.installationId && issued.provider.installationId !== provider.installationId)
      throw new ProviderError("provider_changed", "The selected assistant installation changed. Start a new discussion explicitly.", 409);
    const url = new URL(issued.provider.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ProviderError("provider_url_invalid", "Invalid provider endpoint.", 409);
    // Core's internal origin already identifies the host from this consumer's vantage point.
    if ((this.container || this.core.hostname === "host.docker.internal") && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "host.docker.internal";
    return { ...issued, url: url.href.replace(/\/$/, "") };
  }
  async speechCapabilities(provider: Pick<ProviderDescriptor, "appId" | "key">, signal?: AbortSignal): Promise<SpeechCapabilities> {
    const binding = await this.connect({ ...provider, kind: "speech-to-text" }, signal);
    return read(await fetch(`${binding.url}/capabilities`, { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${binding.token}` } }));
  }
  async transcribe(provider: Pick<ProviderDescriptor, "appId" | "key">, audio: Blob,
    options: { language?: string; signal?: AbortSignal } = {}): Promise<SpeechResult> {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000);
    const binding = await this.connect({ ...provider, kind: "speech-to-text" }, signal);
    const url = new URL(`${binding.url}/transcriptions`);
    if (options.language) url.searchParams.set("language", options.language);
    return read(await fetch(url, { method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${binding.token}`, "content-type": audio.type || "audio/wav" }, body: audio }));
  }
  async translationCapabilities(provider: Pick<ProviderDescriptor, "appId" | "key">, signal?: AbortSignal): Promise<TranslationCapabilities> {
    const binding = await this.connect({ ...provider, kind: "translation" }, signal);
    return read(await fetch(`${binding.url}/capabilities`, { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${binding.token}` } }));
  }
  /** Translate text or Markdown through the explicitly selected provider; never retries or falls back. */
  async translate(provider: Pick<ProviderDescriptor, "appId" | "key">, input: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult> {
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(610_000)]) : AbortSignal.timeout(610_000);
    const binding = await this.connect({ ...provider, kind: "translation" }, deadline);
    const result = await read<TranslationResult>(await fetch(`${binding.url}/translations`, { method: "POST", redirect: "error", signal: deadline,
      headers: { authorization: `Bearer ${binding.token}`, "content-type": "application/json" }, body: JSON.stringify(input) }));
    if (typeof result.text !== "string" || result.targetLanguage !== input.targetLanguage || result.sourceLanguage !== (input.sourceLanguage ?? "auto"))
      throw new ProviderError("provider_response_invalid", "Invalid translation response.", 502);
    return result;
  }
  /** User-attributed requests preserve the assistant's existing handoff and dispatch policy. */
  async assistant(provider: Pick<ProviderDescriptor, "appId" | "key"> & { installationId?: string | null }, userToken: () => Promise<string>): Promise<AssistantClient> {
    const target = { ...provider, kind: "assistant" as const };
    const binding = await this.connect(target, undefined, await userToken());
    return new AssistantClient(binding.url, { version: binding.provider.version, capabilities: binding.provider.capabilities }, async () => {
      const fresh = await this.connect(target, undefined, await userToken());
      if (fresh.url !== binding.url || fresh.provider.installationId !== binding.provider.installationId) throw new ProviderError("provider_changed", "The assistant endpoint or installation changed. Reconnect explicitly.", 409);
      return { token: fresh.token };
    });
  }
  /** Bounded task protocol transport. The selected installation is checked on every operation. */
  async taskRequest<T>(provider: import("./tasks.js").TaskProviderRef, kind: "tasks" | "task-executor",
    route: string, method: string, input?: unknown, userToken?: () => Promise<string>, signal?: AbortSignal): Promise<T> {
    const allowed = kind === "tasks"
      ? /^(?:\/capabilities|\/tasks(?:\?[a-zA-Z0-9%=&_-]*|\/[a-zA-Z0-9-]+(?:\/actions)?)?)$/
      : /^(?:\/options|\/executions\/[a-zA-Z0-9-]+(?:\/cancel)?)$/;
    if (!allowed.test(route) || !["GET", "POST", "PATCH", "PUT"].includes(method))
      throw new ProviderError("task_route_invalid", "Use a version-one task operation.", 400);
    const binding = await this.connect({ ...provider, kind }, signal, await userToken?.());
    return read<T>(await fetch(`${binding.url}${route}`, { method, redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${binding.token}`, "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input) }));
  }
  /** Provider-side validation checks live grants on every request; never cache this result. */
  validate(token: string, kind: ProviderKind, key = "default", signal?: AbortSignal): Promise<ProviderInvocation> {
    return this.coreRequest("/provider/introspect", { token, kind, key }, signal);
  }
}

async function read<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
  if (!response.ok) throw new ProviderError(body?.code ?? "provider_failed", body?.message ?? `Provider request failed (${response.status}).`, response.status);
  if (body === null) throw new ProviderError("provider_response_invalid", "Provider returned an invalid response.", 502);
  return body as T;
}
