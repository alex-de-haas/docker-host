import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { Agent, fetch as request } from "undici";
import { OllamaMcp } from "./tools.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const action of cleanup.splice(0).reverse()) await action();
});

it("uses an owned finite HTTP deadline for a tool approval instead of the default fetch header deadline", async () => {
  // A short default transport reproduces the independent Node response-header ceiling
  // without spending five minutes. The real production SDK/HTTP transport is exercised.
  const short = new Agent({ headersTimeout: 100, bodyTimeout: 100 });
  cleanup.push(() => short.destroy());
  vi.stubGlobal("fetch", (url: Parameters<typeof request>[0], init: Parameters<typeof request>[1]) => request(url, { ...init, dispatcher: short }));
  const server = createServer(async (incoming, response) => {
    if (incoming.method === "GET") { response.writeHead(405); response.end(); return; }
    if (incoming.method === "DELETE") { response.writeHead(200); response.end(); return; }
    const buffers: Buffer[] = [];
    for await (const chunk of incoming) buffers.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(buffers).toString("utf8"));
    if (rpc.method.startsWith("notifications/")) { response.writeHead(202); response.end(); return; }
    response.setHeader("content-type", "application/json");
    const result = rpc.method === "initialize"
      ? { protocolVersion: rpc.params.protocolVersion, serverInfo: { name: "approval-fixture", version: "1" }, capabilities: { tools: {} } }
      : rpc.method === "tools/list"
        ? { tools: [{ name: "list_apps", description: "Safe fixture tool", inputSchema: { type: "object", properties: {} } }] }
        : { content: [{ type: "text", text: "Approved Core result" }] };
    const send = () => response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    if (rpc.method === "tools/call") setTimeout(send, 2100).unref();
    else send();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const mcp = new OllamaMcp();
  cleanup.push(() => mcp.close());
  const origin = `http://127.0.0.1:${address.port}/mcp`;
  await mcp.load({ ordinary: { url: origin } }, new AbortController().signal);
  const binding = [...mcp.bindings.values()][0]!;
  await expect(binding.client.callTool({ name: "list_apps", arguments: {} }, undefined, { timeout: 5000 }))
    .resolves.toMatchObject({ content: [{ type: "text", text: "Approved Core result" }] });
  await mcp.close();
  // Closing and loading again must create a usable new owned dispatcher, not retain a closed one.
  await mcp.load({ ordinary: { url: origin } }, new AbortController().signal);
  expect(mcp.bindings.size).toBe(1);
}, 10000);
