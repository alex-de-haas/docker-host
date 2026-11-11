import { call } from "./api";
import type { PromptTemplate, PromptTemplateDirectory, SavePromptTemplates } from "../../../src/prompt-templates/types";

export type { PromptTemplate } from "../../../src/prompt-templates/types";
export type PromptTemplateCollection = PromptTemplateDirectory;
export type PromptTemplateSave = SavePromptTemplates;
export type PromptTemplateErrors = Partial<Record<"name" | "shortcut" | "text", string>>;

export const loadPromptTemplates = async (): Promise<PromptTemplateCollection> =>
  (await call("/preferences/prompt-templates")).json();

/** Keep this exact input for retries when the response may have been lost. */
export const savePromptTemplates = async (input: PromptTemplateSave): Promise<PromptTemplateCollection> =>
  (await call("/preferences/prompt-templates", { method: "PUT", body: JSON.stringify(input) })).json();

export function validatePromptTemplate(value: PromptTemplate, templates: PromptTemplate[]): PromptTemplateErrors {
  const errors: PromptTemplateErrors = {};
  if (!value.name.trim()) errors.name = "Enter a title.";
  else if (value.name.length > 120) errors.name = "Use at most 120 characters.";
  else if (Array.from(value.name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) errors.name = "Use a single-line title without control characters.";
  const shortcut = value.shortcut.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(shortcut)) {
    errors.shortcut = "Use 1–40 letters (a–z), numbers, underscores or hyphens, starting with a letter or number.";
  } else if (templates.some(template => template.id !== value.id && template.shortcut.toLowerCase() === shortcut)) {
    errors.shortcut = "This shortcut is already used by another template.";
  }
  if (!value.text.trim()) errors.text = "Enter prompt text.";
  else if (value.text.length > 16000) errors.text = "Use at most 16,000 characters.";
  return errors;
}
