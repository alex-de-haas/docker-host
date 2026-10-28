import { catalog } from "../../worker/models.js";
import type { ModelCatalog, ModelChoice } from "../../worker/contracts.js";

export type OllamaCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
    index?: number;
  };
};
export type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaCall[];
  tool_name?: string;
  thinking?: string;
};
export type OllamaTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};
export type ModelDetails = {
  context: number;
  thinking: (string | boolean)[];
  defaultThinking?: string | boolean;
  capabilities: string[];
};
export type ChatResult = {
  message: OllamaMessage;
  inputTokens: number;
  outputTokens: number;
};
export const modelId = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/.test(s);

export function ollamaUrl(value: unknown, docker = false): string {
  if (value === undefined || value === "")
    return docker
      ? "http://host.docker.internal:11434"
      : "http://127.0.0.1:11434";
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Enter an HTTP(S) Ollama server URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter an HTTP(S) Ollama server URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "The Ollama URL must not contain credentials, a query or a fragment.",
    );
  return url.toString().replace(/\/+$/, "");
}

export class OllamaClient {
  readonly url: string;
  constructor(
    url: string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.url = ollamaUrl(url);
  }
  private async response(
    route: string,
    body?: unknown,
    signal?: AbortSignal,
    timeout = 15000,
  ): Promise<Response> {
    const response = await this.request(this.url + "/" + route, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        ...(signal ? [signal] : []),
      ]),
    }).catch((error) => {
      if (signal?.aborted) throw signal.reason;
      throw new Error(
        "Cannot reach Ollama from Worker. Check the server URL and host/container network access.",
        { cause: error },
      );
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Ollama returned HTTP ${response.status}. Check the selected server and installed model.`,
      );
    }
    return response;
  }
  async json(
    route: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, any>> {
    const response = await this.response(route, body, signal);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Ollama returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024)
          throw new Error("Ollama metadata exceeds its limit.");
        chunks.push(value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid Ollama response.");
      return value as Record<string, any>;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async probe(): Promise<void> {
    const value = await this.json("api/version");
    if (typeof value.version !== "string")
      throw new Error("This endpoint did not report an Ollama version.");
  }
  async details(model: string, signal?: AbortSignal): Promise<ModelDetails> {
    if (!modelId(model)) throw new Error("Invalid Ollama model name.");
    const d = await this.json("api/show", { model }, signal);
    if (d.remote_host || d.remote_model || /(?:[:\-]cloud)$/.test(model))
      throw new Error(
        "Cloud-backed models are not enabled for this local Ollama connection.",
      );
    const capabilities = Array.isArray(d.capabilities)
      ? d.capabilities.filter(
          (s: unknown): s is string => typeof s === "string",
        )
      : [];
    if (!capabilities.includes("completion") || !capabilities.includes("tools"))
      throw new Error(
        "This installed model does not advertise agent tool support.",
      );
    const limits = Object.entries(d.model_info ?? {})
      .filter(
        ([k, v]) =>
          k.endsWith(".context_length") &&
          Number.isSafeInteger(v) &&
          Number(v) > 0,
      )
      .map(([, v]) => Number(v));
    const context = Math.min(32768, ...(limits.length ? limits : [8192]));
    const thinking = Array.isArray(d.thinking?.values)
      ? d.thinking.values.filter(
          (v: unknown) =>
            typeof v === "boolean" ||
            (typeof v === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(v)),
        )
      : [];
    return {
      context,
      capabilities,
      thinking,
      ...(thinking.includes(d.thinking?.default)
        ? { defaultThinking: d.thinking.default }
        : {}),
    };
  }
  async models(signal?: AbortSignal): Promise<ModelCatalog> {
    const deadline = AbortSignal.any([
      AbortSignal.timeout(60000),
      ...(signal ? [signal] : []),
    ]);
    const data = await this.json("api/tags", undefined, deadline);
    if (!Array.isArray(data.models) || data.models.length > 200)
      throw new Error("Invalid or oversized Ollama model catalog.");
    const models: ModelChoice[] = [];
    const queue = data.models.filter(
      (
        item: unknown,
      ): item is {
        name: string;
        remote_host?: unknown;
        remote_model?: unknown;
      } =>
        Boolean(
          item &&
            typeof item === "object" &&
            modelId((item as { name?: unknown }).name),
        ),
    );
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (;;) {
          deadline.throwIfAborted();
          const item = queue.shift();
          if (!item) return;
          try {
            if (item.remote_host || item.remote_model)
              throw new Error("Cloud-backed model.");
            const d = await this.details(item.name, deadline);
            models.push({
              id: item.name,
              label: item.name,
              efforts: d.thinking.map((v) => ({
                id: String(v),
                label: v === false ? "Off" : v === true ? "On" : v,
              })),
              ...(d.defaultThinking !== undefined
                ? { defaultEffort: String(d.defaultThinking) }
                : {}),
            });
          } catch (error) {
            deadline.throwIfAborted();
            models.push({
              id: item.name,
              label: item.name,
              efforts: [],
              unavailableReason:
                error instanceof Error
                  ? error.message
                  : "Model capabilities unavailable.",
            });
          }
        }
      }),
    );
    models.sort((a, b) => a.id.localeCompare(b.id));
    return catalog(models, models.find((m) => !m.unavailableReason)?.id);
  }
  async chat(
    messages: OllamaMessage[],
    tools: OllamaTool[],
    model: string,
    details: ModelDetails,
    effort: string | null | undefined,
    signal: AbortSignal,
    delta: (text: string) => void,
  ): Promise<ChatResult> {
    const think =
      effort == null
        ? details.defaultThinking
        : details.thinking.find((v) => String(v) === effort);
    if (effort != null && think === undefined)
      throw new Error(
        "The selected model does not support this thinking setting.",
      );
    const response = await this.response(
      "api/chat",
      {
        model,
        messages,
        tools,
        stream: true,
        options: {
          num_ctx: details.context,
          num_predict: Math.min(4096, Math.floor(details.context / 4)),
        },
        ...(think === undefined ? {} : { think }),
      },
      signal,
      300000,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Ollama returned an empty stream.");
    const decoder = new TextDecoder();
    let buffer = "",
      content = "",
      thinking = "",
      bytes = 0,
      ended = false,
      inputTokens = 0,
      outputTokens = 0;
    const calls: OllamaCall[] = [];
    const frame = (line: string) => {
      if (!line.trim()) return;
      if (ended) throw new Error("Ollama sent data after the final frame.");
      const value = JSON.parse(line);
      if (value.error) throw new Error("Ollama could not complete this turn.");
      if (value.model && value.model !== model)
        throw new Error("Ollama reported a different model.");
      const m = value.message;
      if (m?.content !== undefined) {
        if (typeof m.content !== "string")
          throw new Error("Invalid Ollama content.");
        content += m.content;
        delta(m.content);
      }
      if (m?.thinking !== undefined) {
        if (typeof m.thinking !== "string")
          throw new Error("Invalid Ollama thinking.");
        thinking += m.thinking;
      }
      if (m?.tool_calls !== undefined) {
        if (!Array.isArray(m.tool_calls))
          throw new Error("Invalid Ollama tool calls.");
        for (const call of m.tool_calls) {
          if (
            !call?.function ||
            typeof call.function.name !== "string" ||
            call.function.name.length > 200 ||
            !call.function.arguments ||
            typeof call.function.arguments !== "object" ||
            Array.isArray(call.function.arguments)
          )
            throw new Error("Invalid Ollama tool arguments.");
          if (calls.length >= 32)
            throw new Error("Too many tool calls in one response.");
          calls.push({
            function: {
              name: call.function.name,
              arguments: call.function.arguments,
            },
          });
        }
      }
      if (value.done === true) {
        ended = true;
        if (value.done_reason === "length")
          throw new Error(
            "Ollama reached its output limit. Continue with a smaller request.",
          );
        inputTokens = Number.isSafeInteger(value.prompt_eval_count)
          ? value.prompt_eval_count
          : 0;
        outputTokens = Number.isSafeInteger(value.eval_count)
          ? value.eval_count
          : 0;
      }
    };
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2 * 1024 * 1024)
          throw new Error("Ollama output exceeds its limit.");
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          frame(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) frame(buffer);
      if (!ended)
        throw new Error(
          "Ollama stream ended before completion; no tools were executed.",
        );
      return {
        message: {
          role: "assistant",
          content,
          ...(thinking ? { thinking } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        inputTokens,
        outputTokens,
      };
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
