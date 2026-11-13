import { beforeEach, expect, it, vi } from "vitest";
import { call } from "./api";
import { loadPromptTemplates, savePromptTemplates, validatePromptTemplate, type PromptTemplate } from "./prompt-templates-api";

vi.mock("./api", () => ({ call: vi.fn() }));
const template: PromptTemplate = { id: "c50a33ce-ebc1-4b31-ad34-c9c184940ab3", name: "Pull request", shortcut: "pr", text: "  Создай PR\n@literal /text\n" };
beforeEach(() => vi.resetAllMocks());

it("loads personal templates and sends the caller's exact replay identity and text", async () => {
  const collection = { revision: 2, templates: [template] };
  vi.mocked(call).mockResolvedValue(Response.json(collection));
  expect(await loadPromptTemplates()).toEqual(collection);
  expect(call).toHaveBeenCalledWith("/preferences/prompt-templates");
  const input = { ...collection, requestId: "3d0513f9-de82-4d11-8893-a643a5f55bf3" };
  vi.mocked(call).mockResolvedValue(Response.json(collection));
  expect(await savePromptTemplates(input)).toEqual(collection);
  expect(call).toHaveBeenLastCalledWith("/preferences/prompt-templates", { method: "PUT", body: JSON.stringify(input) });
  vi.mocked(call).mockResolvedValue(Response.json(collection));
  await savePromptTemplates(input);
  expect(vi.mocked(call).mock.calls.at(-1)).toEqual(vi.mocked(call).mock.calls.at(-2));
});

it("validates normalized shortcuts, case-insensitive duplicates and significant prompt whitespace", () => {
  expect(validatePromptTemplate({ ...template, id: "new", shortcut: " PR " }, [template]).shortcut).toContain("already used");
  expect(validatePromptTemplate({ ...template, shortcut: "PR" }, [template])).toEqual({});
  expect(validatePromptTemplate({ ...template, shortcut: "!pr" }, []).shortcut).toBeTruthy();
  expect(validatePromptTemplate({ ...template, shortcut: "пр" }, []).shortcut).toBeTruthy();
  expect(validatePromptTemplate({ ...template, name: "Bad\u0000title" }, []).name).toContain("control characters");
  expect(validatePromptTemplate({ ...template, name: " ", text: "\n\t " }, [])).toMatchObject({ name: expect.any(String), text: expect.any(String) });
  expect(validatePromptTemplate({ ...template, name: "a".repeat(120), shortcut: "a".repeat(40), text: "a".repeat(16000) }, [])).toEqual({});
  expect(validatePromptTemplate({ ...template, name: "a".repeat(121), shortcut: "a".repeat(41), text: "a".repeat(16001) }, [])).toMatchObject({ name: expect.any(String), shortcut: expect.any(String), text: expect.any(String) });
});
