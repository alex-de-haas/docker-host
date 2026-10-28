import { createHash } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OllamaTool } from "./client.js";

const text = { type: "string", maxLength: 32000 };
const file = { type: "string", minLength: 1, maxLength: 2048 };
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
export const LOCAL_TOOLS: OllamaTool[] = [
  [
    "discover_tools",
    "Search authorized MCP tools by service name or purpose. Matching tool definitions become available on the next model step.",
    object({ query: { type: "string", maxLength: 200 } }, ["query"]),
  ],
  [
    "read_file",
    "Read a workspace text file. Use offset to page large files.",
    object(
      {
        path: file,
        offset: { type: "integer", minimum: 0 },
        length: { type: "integer", minimum: 1, maximum: 24000 },
      },
      ["path"],
    ),
  ],
  [
    "list_directory",
    "List a workspace directory, with paging.",
    object({ path: file, offset: { type: "integer", minimum: 0 } }),
  ],
  [
    "search_text",
    "Find literal text in workspace files. Skips generated/dependency directories.",
    object({ path: file, query: { ...text, minLength: 1, maxLength: 1000 } }, [
      "query",
    ]),
  ],
  [
    "apply_patch",
    "Replace one exact occurrence of old_text in a workspace file with new_text. Empty old_text creates a new file only. Changes require policy approval.",
    object({ path: file, old_text: text, new_text: text }, [
      "path",
      "old_text",
      "new_text",
    ]),
  ],
  [
    "run_command",
    "Run a shell command in the selected workspace. State what it does; commands require policy approval. Commands are foreground tasks; background services and detached processes are unsupported.",
    object(
      {
        command: { ...text, minLength: 1, maxLength: 8000 },
        cwd: file,
        timeout_ms: { type: "integer", minimum: 100, maximum: 300000 },
      },
      ["command"],
    ),
  ],
  [
    "ask_user",
    "Ask one concise question and wait for the user's answer.",
    object(
      {
        question: { ...text, minLength: 1, maxLength: 2000 },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 100 },
        },
      },
      ["question", "options"],
    ),
  ],
  [
    "read_skill",
    "Read an explicitly selected skill. name must come from the selected skills index. path defaults to SKILL.md.",
    object({ name: file, path: file }, ["name"]),
  ],
].map(([name, description, parameters]) => ({
  type: "function",
  function: {
    name: name as string,
    description: description as string,
    parameters: parameters as Record<string, unknown>,
  },
}));
type ValidateFunction = (value: unknown) => boolean;
export const schemaValidator = () => ({
  compile(schema: Record<string, unknown>): ValidateFunction {
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    return (value) => validate(value).valid;
  },
});
export type RemoteTool = {
  displayName: string;
  client: Client;
  name: string;
  validate: ValidateFunction;
  server: string;
};
export class OllamaMcp {
  readonly tools: OllamaTool[] = [];
  readonly bindings = new Map<string, RemoteTool>();
  private clients: Client[] = [];
  async load(
    servers: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.close();
    const ajv = schemaValidator();
    for (const [server, value] of Object.entries(servers)) {
      signal.throwIfAborted();
      const config = value as { url: string; headers?: Record<string, string> };
      const client = new Client({ name: "hosty-ollama", version: "1" });
      this.clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers },
          fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
        }),
        { signal, timeout: 15000 },
      );
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          signal,
          timeout: 15000,
        });
        for (const tool of page.tools) {
          if (this.tools.length >= 128)
            throw new Error("Too many MCP tools for the Ollama catalog.");
          if (JSON.stringify(tool.inputSchema).length > 32000)
            throw new Error("MCP tool schema exceeds its limit.");
          const displayName = `mcp__${server}__${tool.name}`;
          const alias =
            "mcp_" +
            createHash("sha256").update(displayName).digest("hex").slice(0, 24);
          if (this.bindings.has(alias))
            throw new Error("Duplicate MCP tool name.");
          const validate = ajv.compile(tool.inputSchema);
          this.tools.push({
            type: "function",
            function: {
              name: alias,
              description: (
                displayName +
                " — " +
                (tool.description ?? "")
              ).slice(0, 2000),
              parameters: tool.inputSchema,
            },
          });
          this.bindings.set(alias, {
            client,
            name: tool.name,
            displayName,
            server,
            validate,
          });
        }
        cursor = page.nextCursor;
        if (cursor) {
          if (cursors.has(cursor))
            throw new Error("MCP catalog repeated its cursor.");
          cursors.add(cursor);
        }
      } while (cursor);
    }
  }
  async close(): Promise<void> {
    const clients = this.clients.splice(0);
    this.tools.length = 0;
    this.bindings.clear();
    await Promise.allSettled(clients.map((c) => c.close()));
  }
}
