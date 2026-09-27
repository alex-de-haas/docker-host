import { describe, expect, it } from "vitest";
import { captureEnv } from "./test-env.js";

// The helper the suites clean up with. Its only job is the difference between "delete" and "put
// back what was there", which is exactly the difference a test file that deletes unconditionally
// gets wrong — and gets wrong invisibly, in whatever runs after it.
describe("captureEnv", () => {
  const name = "HOSTY_TEST_ENV_PROBE";

  it("deletes a variable that had no value before", () => {
    delete process.env[name];

    const restore = captureEnv({ [name]: "borrowed" });
    expect(process.env[name]).toBe("borrowed");
    restore();

    expect(name in process.env).toBe(false);
  });

  it("puts back a value the environment already had", () => {
    // The developer's shell, or a CI job that exports it for the whole run. Deleting it here would
    // take it away from every file that runs after this one.
    process.env[name] = "the environment's own";

    const restore = captureEnv({ [name]: "borrowed" });
    restore();

    expect(process.env[name]).toBe("the environment's own");
    delete process.env[name];
  });

  it("restores a variable it only borrowed, whatever a test then set it to", () => {
    // `undefined` means "do not set this, only remember it": the shape a suite needs for variables
    // individual tests point at a stub server they then close.
    process.env[name] = "the environment's own";

    const restore = captureEnv({ [name]: undefined });
    expect(process.env[name]).toBe("the environment's own");
    process.env[name] = "what a test set";
    restore();

    expect(process.env[name]).toBe("the environment's own");
    delete process.env[name];
  });
});
