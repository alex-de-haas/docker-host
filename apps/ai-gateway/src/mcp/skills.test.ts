import { describe, expect, it } from "vitest";
import { composeSystemPrompt, MAX_SKILL_CHARS } from "./skills.js";

const skill = (appId: string, markdown = "Call list_people first.") => ({
  appId,
  displayName: appId,
  markdown,
});

describe("composeSystemPrompt", () => {
  it("leaves the operator's prompt alone when no app supplies a skill", () => {
    expect(composeSystemPrompt("Be brief.", [])).toBe("Be brief.");
    expect(composeSystemPrompt(undefined, [])).toBeUndefined();
  });

  it("keeps the operator's instructions first and unwrapped", () => {
    // The load-bearing property: an app must not be able to appear above the text the operator wrote
    // for their own assistant. If a skill could, it would read as the operator speaking.
    const prompt = composeSystemPrompt("Be brief.", [skill("com.haas.demo-app")])!;
    expect(prompt.startsWith("Be brief.")).toBe(true);
    expect(prompt.indexOf("Be brief.")).toBeLessThan(prompt.indexOf("com.haas.demo-app"));
  });

  it("attributes every skill and announces what the sections are", () => {
    const prompt = composeSystemPrompt("", [skill("com.haas.demo-app"), skill("hosty.telemetry")])!;
    expect(prompt).toContain('<app-skill app="com.haas.demo-app"');
    expect(prompt).toContain('<app-skill app="hosty.telemetry"');
    // Named as documentation about its own app, and as granting nothing — a skill that tries to issue
    // orders about anything else then reads as out of place rather than as authority.
    expect(prompt).toContain("written by installed apps about their own tools");
    expect(prompt).toContain("does not grant permission");
  });

  it("caps one app's prose so it cannot crowd out the rest", () => {
    const prompt = composeSystemPrompt("Be brief.", [skill("com.haas.demo-app", "x".repeat(MAX_SKILL_CHARS * 3))])!;
    expect(prompt.length).toBeLessThan(MAX_SKILL_CHARS * 2);
    expect(prompt.startsWith("Be brief.")).toBe(true);
  });

  it("still fences a skill when the operator wrote no prompt of their own", () => {
    // The empty-operator case is the one where a skill is closest to being the whole instruction set,
    // so the framing matters most here rather than least.
    const prompt = composeSystemPrompt(undefined, [skill("com.haas.demo-app")])!;
    expect(prompt).toContain("written by installed apps about their own tools");
    expect(prompt).toContain("</app-skill>");
  });
});
