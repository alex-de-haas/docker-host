import { describe, expect, it } from "vitest";
import { authorizeServiceToken } from "@/lib/service-token";

describe("authorizeServiceToken", () => {
  it("fails closed without a configured token", () => {
    const decision = authorizeServiceToken("anything", null);

    expect(decision).toMatchObject({ ok: false, status: 503, code: "marketplace_token_unconfigured" });
  });

  it.each([null, "", "wrong-token"])("rejects missing or invalid token %j", presented => {
    const decision = authorizeServiceToken(presented, "expected-token");

    expect(decision).toMatchObject({ ok: false, status: 401, code: "marketplace_token_invalid" });
  });

  it("accepts the exact token", () => {
    expect(authorizeServiceToken("expected-token", "expected-token")).toEqual({ ok: true });
  });

  it("trims the presented header value", () => {
    expect(authorizeServiceToken("  expected-token  ", "expected-token")).toEqual({ ok: true });
  });
});
