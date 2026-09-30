import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, expect, it, vi } from "vitest";
import { speechRoute } from "./speech.js";

const api = vi.hoisted(() => ({ permissions: vi.fn(), list: vi.fn() }));
vi.mock("@hosty-sdk/app/providers/server", () => ({
  ProviderClient: class { permissions = api.permissions; list = api.list; },
}));

beforeEach(() => { vi.clearAllMocks(); api.list.mockResolvedValue([]); });

it.each([
  [[], [], false, false],
  [["providers.speech-to-text"], [], true, false],
  [["providers.speech-to-text"], ["providers.speech-to-text"], true, true],
])("reports persisted optional consent separately from grants (%j, %j)", async (optional, granted, requestable, allowed) => {
  api.permissions.mockResolvedValue({ required: [], optional, granted });
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() });
  await speechRoute({ method: "GET" } as IncomingMessage, response as unknown as ServerResponse,
    new URL("http://harness.test/api/speech/providers"));
  expect(JSON.parse(response.end.mock.calls[0]![0])).toEqual({ granted: allowed, requestable, providers: [] });
  expect(api.list).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("advertises manifest review on a capable Core even for legacy declarations", async () => {
  api.permissions.mockResolvedValue({ required: [], optional: [], granted: [], reviewAvailable: true });
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn() });
  await speechRoute({ method: "GET" } as IncomingMessage, response as unknown as ServerResponse, new URL("http://harness.test/api/speech/providers"));
  expect(JSON.parse(response.end.mock.calls[0]![0])).toMatchObject({ granted: false, requestable: false, reviewAvailable: true });
});
