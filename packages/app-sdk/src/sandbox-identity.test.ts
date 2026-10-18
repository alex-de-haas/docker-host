import { describe, expect, it } from "vitest";
import { readSandboxIdentity, readSandboxTarget } from "./index";

const target = { runtimeInstanceId: "a".repeat(32), generation: "b".repeat(32), dataRevision: "c".repeat(32) };
const payload = { ...target, identityRealm: "sandbox", hostRole: null, appRole: "admin", permissions: ["demo.roles.manage"] };
describe("sandbox identity scope", () => {
  it("keeps a test administrator inside its typed execution scope", () => {
    expect(readSandboxIdentity(payload, target)).toEqual({ ...target, identityRealm: "sandbox", appRole: "admin", permissions: ["demo.roles.manage"] });
    expect(() => readSandboxIdentity(payload, null)).toThrow();
    expect(() => readSandboxIdentity({ ...payload, hostRole: "host.admin" }, target)).toThrow();
  });
  it.each(["runtimeInstanceId", "generation", "dataRevision"] as const)("rejects a changed %s before role resolution", field => {
    expect(() => readSandboxIdentity({ ...payload, [field]: "d".repeat(32) }, target)).toThrow();
  });
  it("requires explicit compatible realm metadata even for a real operator", () => {
    expect(readSandboxIdentity({ ...payload, identityRealm: "core", hostRole: "host.admin" }, target)?.identityRealm).toBe("core");
    expect(() => readSandboxIdentity({ hostRole: "host.admin" }, target)).toThrow();
    expect(readSandboxIdentity({ hostRole: "host.admin" }, null)).toBeNull();
  });
  it("does not turn partial environment into installed-app mode", () => {
    expect(readSandboxTarget({})).toBeNull();
    expect(() => readSandboxTarget({ HOSTY_SANDBOX_INSTANCE_ID: target.runtimeInstanceId })).toThrow();
    expect(readSandboxTarget({ HOSTY_SANDBOX_PROTOCOL: "hosty-sandbox-v1", HOSTY_SANDBOX_INSTANCE_ID: target.runtimeInstanceId,
      HOSTY_SANDBOX_GENERATION: target.generation, HOSTY_SANDBOX_DATA_REVISION: target.dataRevision })).toEqual(target);
  });
});
