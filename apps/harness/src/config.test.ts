import { expect, it } from "vitest";
import { loadConfig } from "./config.js";

it("binds Docker's container port while Local uses Core's allocated host port", () => {
  expect(loadConfig({ HOSTY_HARNESS_RUNTIME: "docker", HOSTY_PORT_HTTP: "25119" }).port).toBe(3400);
  expect(loadConfig({ HOSTY_HARNESS_RUNTIME: "native", HOSTY_PORT_HTTP: "25119" }).port).toBe(25119);
  expect(loadConfig({ HOSTY_HARNESS_RUNTIME: "docker", HOSTY_PORT_HTTP: "25119", PORT: "3500" }).port).toBe(3500);
});
