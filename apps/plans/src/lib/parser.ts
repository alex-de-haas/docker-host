import { parseDocument as parseYaml } from "yaml";
import { STATUSES, type ParsedDocument, type Deliverable, type PlanStatus } from "./types";

export type ValidationContext = { componentExists?: (path: string) => boolean; linkExists?: (path: string) => boolean };
const PLAIN_FIRST = new Set([..."-?:,[]{}#&*!|>'\"%@`"]);
function scalar(raw: string, inList: boolean): string {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"') || !/^(?:[^"\\]|\\["\\])*$/.test(raw.slice(1, -1)))
      throw new Error("Malformed double-quoted string; only escaped quotes and backslashes are allowed.");
  } else {
    if (raw !== raw.trim() || raw === "") throw new Error("Empty value or surrounding whitespace.");
    if (PLAIN_FIRST.has(raw[0])) throw new Error("Value starts with a YAML indicator; wrap it in double quotes.");
    if (raw.includes(": ") || raw.includes(" #") || raw.endsWith(":")) throw new Error("Wrap values containing a colon or comment in double quotes.");
    if (inList && /[,[\]{}]/.test(raw)) throw new Error("List item contains a flow indicator.");
  }
  // Failsafe preserves dates, numbers and booleans as strings. General YAML constructs have
  // already been excluded using the canonical validator's exact scalar/list rules above.
  const parsed = parseYaml(raw, { schema: "failsafe", uniqueKeys: true, customTags: [] });
  if (parsed.errors.length || typeof parsed.toJSON() !== "string") throw new Error("Invalid scalar value.");
  return parsed.toJSON() as string;
}
function value(raw: string): string | string[] {
  if (!raw.startsWith("[")) return scalar(raw, false);
  if (!raw.endsWith("]")) throw new Error("Unterminated list.");
  const inner = raw.slice(1, -1).trim();
  if (!inner) throw new Error("Empty list; omit the key instead.");
  return inner.split(",").map(part => scalar(part.trim(), true));
}
export function proseLines(lines: string[], from = 0): { index: number; line: string }[] {
  const out: { index: number; line: string }[] = [];
  let fence: string | null = null;
  for (let i = from; i < lines.length; i++) {
    if (fence === null) {
      const open = lines[i].match(/^\s*(`{3,}|~{3,})/);
      if (open) fence = open[1]; else out.push({ index: i, line: lines[i] });
    } else {
      const close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    }
  }
  return out;
}
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}
export function resolveRepositoryPath(from: string, target: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length) parts.pop(); else return "../" + target; }
    else parts.push(part);
  }
  return parts.join("/");
}
export function parseSourceDocument(path: string, content: string, context: ValidationContext = {}): ParsedDocument {
  const errors: string[] = [];
  const lines = content.split("\n");
  const kind = /\/plan\.md$/.test(path) ? "plan" : /\/feature\.md$/.test(path) ? "feature" : path === "docs/vision.md" ? "vision" : null;
  const data: Record<string, string | string[]> = {};
  let bodyStart = 0;
  if (content.includes("\0")) errors.push("Document contains a NUL byte.");
  if (kind) {
    if (lines[0] !== "---") errors.push("Missing frontmatter.");
    else {
      const close = lines.indexOf("---", 1);
      bodyStart = close < 0 ? lines.length : close + 1;
      if (close < 0) errors.push("Frontmatter is not closed.");
      else for (let i = 1; i < close; i++) {
        const match = lines[i].match(/^([a-z][a-z0-9-]*):(?: (.*))?$/);
        if (!match) { errors.push(`Line ${i + 1}: frontmatter must be key: value.`); continue; }
        const [, key, raw = ""] = match;
        if (key in data) errors.push(`Line ${i + 1}: duplicate key ${key}.`);
        try { data[key] = value(raw); } catch (error) { errors.push(`Line ${i + 1}: ${key}: ${(error as Error).message}`); }
      }
    }
    const required = kind === "plan" ? ["status", "created", "updated", "summary"] : kind === "feature" ? ["created", "updated", "summary"] : ["created", "updated"];
    const allowed = [...required, ...(kind === "vision" ? [] : ["components"])];
    for (const key of Object.keys(data)) if (!allowed.includes(key)) errors.push(`Unknown frontmatter key ${key}.`);
    for (const key of required) if (!(key in data)) errors.push(`Missing frontmatter key ${key}.`);
    if (kind === "plan" && "status" in data && !STATUSES.includes(data.status as PlanStatus)) errors.push("Unknown plan status.");
    for (const key of ["created", "updated"]) if (key in data && !validDate(data[key])) errors.push(`${key} must be a YYYY-MM-DD date.`);
    if (validDate(data.created) && validDate(data.updated) && data.updated < data.created) errors.push("Updated date is earlier than created date.");
    if ("summary" in data) {
      const summary = data.summary;
      if (typeof summary !== "string") errors.push("Summary must be a sentence, not a list.");
      else if (summary.length > 200) errors.push("Summary exceeds 200 characters.");
      else if (/[`[\]*~]|(^|[\s(])_|_($|[\s).,;:!?])|<[A-Za-z/!]/.test(summary)) errors.push("Summary must be plain text.");
      else if (/[.!?]["')]?\s+\S/.test(summary)) errors.push("Summary must be one sentence.");
    }
    for (const line of lines.slice(bodyStart)) {
      if (line.startsWith("## ")) break;
      if (/^(Status|Created|Updated):\s*(.+?)\s*$/.test(line)) errors.push("Legacy headers must be moved into frontmatter.");
    }
  }
  const prose = proseLines(lines, bodyStart);
  const title = prose.find(item => item.line.trim())?.line.match(/^# (.+?)\s*#*\s*$/)?.[1];
  if (kind && !title) errors.push("The first line after frontmatter must be the # Title heading.");
  const components = "components" in data ? Array.isArray(data.components) ? data.components : [data.components] : [];
  if (new Set(components).size !== components.length) errors.push("Components lists a directory twice.");
  for (const component of components) {
    if (!/^[A-Za-z0-9._/-]+$/.test(component) || component.split("/").some(part => !part || part === "." || part === "..")) errors.push(`Invalid component directory ${component}.`);
    else if (context.componentExists && !context.componentExists(component)) errors.push(`Component ${component} is not a directory in this repository.`);
  }
  for (const { index, line } of prose) {
    const text = line.replace(/(`+)[^`]*?\1/g, "");
    const targets = [...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(match => match[1]);
    const definition = text.match(/^\s*\[[^\]]+\]:\s+<?([^\s>]+)>?/);
    if (definition) targets.push(definition[1]);
    for (const target of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      let raw = target.replace(/[#?].*$/, "");
      try { raw = decodeURIComponent(raw); } catch { /* Match the validator's raw-path fallback. */ }
      if (raw.startsWith("/")) errors.push(`Line ${index + 1}: link ${target} is absolute; use a relative path.`);
      else if (context.linkExists && !context.linkExists(resolveRepositoryPath(path, raw))) errors.push(`Line ${index + 1}: broken link ${target}.`);
    }
  }
  if (kind === "feature" && prose.filter(item => /^## /.test(item.line)).at(-1)?.line.trim() !== "## Testing Expectations") errors.push("Feature must end with ## Testing Expectations.");
  const deliverables: Deliverable[] = [];
  if (kind === "plan") {
    let section: string | null = null;
    let sections = 0;
    const ids = new Set<string>();
    for (const { index, line } of prose) {
      if (/^## /.test(line)) { section = line.trim(); if (section === "## Deliverables" && ++sections === 2) errors.push("Plan has more than one ## Deliverables section."); continue; }
      if (/^# /.test(line)) section = null;
      const box = line.match(/^(\s*)([-*+]) \[([ xX])\](.*)$/);
      if (!box) continue;
      const [, indent, bullet, mark, rest] = box;
      if (section !== "## Deliverables") { errors.push(`Line ${index + 1}: checkbox outside ## Deliverables.`); continue; }
      if (indent !== "") { errors.push(`Line ${index + 1}: nested checkbox.`); continue; }
      if (bullet !== "-" || mark === "X") errors.push(`Line ${index + 1}: write deliverables as - [ ] or - [x].`);
      const id = rest.match(/^ D([1-9]\d*)\. \S/);
      if (!id) { errors.push(`Line ${index + 1}: deliverable without a D<n>. ID.`); continue; }
      if (ids.has(id[1])) errors.push(`Duplicate deliverable ID D${id[1]}.`);
      ids.add(id[1]);
      deliverables.push({ id: `D${id[1]}`, text: rest.slice(id[1].length + 4), done: mark !== " " });
    }
    if (!sections) errors.push("Plan needs a ## Deliverables section.");
    else if (!deliverables.length) errors.push("Plan needs at least one deliverable.");
  }
  return {
    path, title: title ?? path, content, body: lines.slice(bodyStart).join("\n"), summary: typeof data.summary === "string" ? data.summary : "",
    status: STATUSES.includes(data.status as PlanStatus) ? data.status as PlanStatus : null,
    created: validDate(data.created) ? data.created : null, updated: validDate(data.updated) ? data.updated : null,
    components, deliverables, progress: kind === "plan" && !errors.length ? { done: deliverables.filter(item => item.done).length, total: deliverables.length } : null, errors,
  };
}
