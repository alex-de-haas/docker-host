// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SkillLibrary } from "./skill-library";
import { call } from "@/lib/api";
vi.mock("@/lib/api", () => ({ call: vi.fn() }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(call).mockImplementation(async path => Response.json(path === "/source-connections" ? { connections: [] } : path === "/skills" ? {
    skills: ["hosty-app-skill", "hosty-platform"].map((name, i) => ({ id: String(i), name, description: "Packaged guidance", sourceKind: "core", coreVersion: "1.2.3", fileCount: 2, bytes: 1000 }))
  } : { content: btoa("Packaged Core reference"), files: ["SKILL.md", "references/introduction.md"] }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
it("shows both built-in packages with their Core version and readable files without Git management actions", async () => {
  await act(async () => root.render(<SkillLibrary />));
  const rows = [...container.querySelectorAll("article")];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.textContent).toContain("Core · 1.2.3");
    expect([...row.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Read"]);
  }
  await act(async () => (rows[1]!.querySelector("button") as HTMLButtonElement).click());
  expect(container.textContent).toContain("Packaged Core reference");
  expect(call).toHaveBeenCalledWith("/skills/1/content?path=SKILL.md", { method: "GET" });
});
