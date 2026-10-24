import { AppContextError } from "./sessions/app-context.js";

type Json = Record<string, unknown>;
export type WorkspaceApplicationChoice = {
  kind: string; runtime?: string; workspaceId?: string; worktreeId?: string; name: string;
  available?: boolean; unavailable?: string;
};
export type WorkspaceApplication = {
  appId: string; name: string; version?: string; runtimeState?: string; operationStatus?: string; health?: string;
  current?: WorkspaceApplicationChoice; target?: WorkspaceApplicationChoice;
  source?: { path?: string; branch?: string; state?: string }; canSwitch: boolean; unavailable?: string;
};
export type WorkspaceApplicationsRoute = { workspaceId: string; appId?: string; requestId?: string };
const appPattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Json | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const objects = (value: unknown): Json[] => Array.isArray(value) ? value.flatMap(item => object(item) ? [item as Json] : []) : [];

/** This is a workspace-bound surface, never an arbitrary Core management proxy. */
export function workspaceApplicationsRoute(method: string, path: string): WorkspaceApplicationsRoute | null {
  const match = path.match(/^\/api\/development-workspaces\/([a-f0-9]{64})\/applications(?:\/([a-z0-9][a-z0-9._-]{0,62})\/execution-target(?:\/([0-9a-f-]{36}))?)?$/i);
  if (!match || !/^[a-f0-9]{64}$/.test(match[1]!) || match[2] && !appPattern.test(match[2]) || match[3] && !uuidPattern.test(match[3])) return null;
  if (method === "GET" && (!match[2] || match[3]) || method === "POST" && match[2] && !match[3])
    return { workspaceId: match[1]!, appId: match[2], requestId: match[3] };
  return null;
}

function choice(value: unknown): WorkspaceApplicationChoice | undefined {
  const source = object(value);
  if (!source || !["package", "workspace", "legacy"].includes(String(source.kind))) return undefined;
  return { kind: String(source.kind), name: text(source.name) ?? "Unknown target", runtime: text(source.runtime),
    workspaceId: text(source.workspaceId), worktreeId: text(source.worktreeId),
    available: typeof source.available === "boolean" ? source.available : undefined, unavailable: text(source.unavailable) };
}

export type WorkspaceApplicationsConnection = {
  origin: string; serviceToken: string; appId: string;
  inspect: (credential: string) => Promise<unknown>;
};

/** Core revalidates current grants and owns installation/source binding checks and replay receipts. */
export async function requestWorkspaceApplications(method: string, path: string, credential: string,
  body: unknown, connection: WorkspaceApplicationsConnection): Promise<unknown> {
  const route = workspaceApplicationsRoute(method, path);
  if (!route) throw new AppContextError(404, "not_found", "Unknown workspace application operation.");
  const inventory = object(await connection.inspect(credential));
  const workspace = objects(inventory?.workspaces).find(item => item.id === route.workspaceId);
  if (!workspace) throw new AppContextError(404, "workspace_not_found", "This workspace is unavailable to the current operator.");
  const trees = objects(workspace.worktrees);
  const bindings = new Map<string, { name: string; trees: Json[] }>();
  for (const tree of trees) for (const binding of objects(tree.apps)) {
    const appId = text(binding.appId);
    if (!appId || !appPattern.test(appId) || binding.installed !== true) continue;
    const prior = bindings.get(appId);
    if (prior) prior.trees.push(tree);
    else bindings.set(appId, { name: text(binding.name) ?? appId, trees: [tree] });
  }
  if (route.appId && !bindings.has(route.appId))
    throw new AppContextError(403, "workspace_application_forbidden", "The application is not bound to this workspace installation.");

  const request = async (corePath: string, input?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(new URL(corePath, connection.origin), {
        method: input === undefined ? "GET" : "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${connection.serviceToken}`, "X-Hosty-App-Identity": credential, "content-type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
    } catch { throw new AppContextError(503, "core_unavailable", "Core could not complete the application request. Keep the original request ID for recovery."); }
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new AppContextError(response.ok ? 502 : response.status, "core_response_invalid", "Core returned an incomplete application response."); }
    if (!response.ok) {
      const error = object(value);
      throw new AppContextError(response.status, text(error?.code) ?? "workspace_application_failed",
        text(error?.message) ?? "Core refused the workspace application request.");
    }
    return value;
  };

  if (route.appId) {
    let result: unknown;
    let expectedRequestId = route.requestId;
    const root = `/api/apps/${encodeURIComponent(route.appId)}/execution-target`;
    if (method === "POST") {
      const input = object(body);
      if (!input || Object.keys(input).some(key => !["requestId", "kind", "workspaceId", "worktreeId", "runtime"].includes(key)) ||
          !uuidPattern.test(text(input.requestId) ?? "") || input.kind !== "workspace" || input.workspaceId !== route.workspaceId ||
          typeof input.worktreeId !== "string" || !bindings.get(route.appId)!.trees.some(tree => tree.id === input.worktreeId && tree.state === "active") ||
          input.runtime !== undefined && (typeof input.runtime !== "string" || !input.runtime.trim() || input.runtime.length > 128))
        throw new AppContextError(400, "workspace_execution_invalid", "Keep the original UUID and select this application's exact bound workspace and worktree.");
      // Do not replace retained arguments with the latest inventory's recipe. Core decides replay.
      expectedRequestId = String(input.requestId);
      result = await request(root, input);
    } else result = await request(`${root}/${route.requestId}`);
    const status = object(result);
    if (!status || !["running", "completed", "review-required", "failed"].includes(String(status.state)) ||
        !uuidPattern.test(text(status.requestId) ?? "") || status.requestId !== expectedRequestId)
      throw new AppContextError(502, "core_response_invalid", "Core returned an incomplete execution status.");
    const review = object(status.review);
    return { requestId: status.requestId, state: status.state, code: text(status.code), error: text(status.error),
      ...(object(review?.workspaceManifest) ? { review: { workspaceManifest: review!.workspaceManifest } } : {}) };
  }

  const [appsValue, choicesValue] = await Promise.all([request("/api/apps"), request("/api/apps/execution-targets")]);
  const apps = objects(object(appsValue)?.apps), targets = objects(object(choicesValue)?.apps);
  const caller = apps.find(app => app.id === connection.appId);
  const grants = Array.isArray(caller?.grantedCorePermissions) ? caller.grantedCorePermissions : [];
  const lifecycle = grants.includes("apps.lifecycle"), source = grants.includes("apps.sources.full");
  const workflow = object(workspace.workflow);
  const active = workflow?.state === "in-progress" && !workflow.closure;
  const rows = await Promise.all([...bindings].map(async ([appId, binding]): Promise<WorkspaceApplication> => {
    const app = apps.find(item => item.id === appId);
    const execution = targets.find(item => item.appId === appId);
    const current = choice(execution?.current);
    const target = objects(execution?.choices).map(choice).find(item => item?.kind === "workspace" && item.workspaceId === route.workspaceId &&
      (item.worktreeId === undefined || binding.trees.some(tree => tree.id === item.worktreeId && tree.state === "active")));
    const unavailable = !app ? "Application is no longer installed."
      : !execution || !current ? "Current execution target is unavailable."
      : !lifecycle ? "Harness does not have application lifecycle permission."
      : !source ? "Harness does not have source workspace permission."
      : !active ? "Resume this workspace before using its applications."
      : !target ? "No execution target is available for this bound worktree."
      : target.available !== true || !target.worktreeId ? target.unavailable ?? "This workspace target is unavailable." : undefined;
    const row: WorkspaceApplication = { appId, name: binding.name, version: text(app?.version), runtimeState: text(app?.runtimeState),
      operationStatus: text(app?.operationStatus), health: text(object(app?.health)?.status), current, target,
      canSwitch: unavailable === undefined, unavailable };
    const profiles = objects(app?.runtimeProfiles);
    const live = current?.kind === "legacy" || current?.kind !== "workspace" &&
      (app?.live === true || profiles.some(profile => profile.key === app?.selectedRuntime && profile.development === true));
    if (live && app) {
      row.source = { path: text(app.sourceLivePath) ?? text(app.sourceOverridePath) ?? text(app.sourceManagedPath), state: "unknown" };
      if (lifecycle) {
        try {
          const summary = object(await request(`/api/apps/${encodeURIComponent(appId)}/source/summary`));
          if (summary?.appId === appId) row.source = { path: text(summary.scopePath) ?? row.source.path,
            branch: text(summary.branch), state: text(summary.state) ?? "unknown" };
        } catch { /* Source detail failure does not turn an unknown source into a package target. */ }
      }
    }
    return row;
  }));
  return { apps: rows };
}
