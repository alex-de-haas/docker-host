import { coreEnvironmentActions, type CoreEnvironmentAction } from "@hosty-sdk/app/sandbox/server";
const descriptions: Record<CoreEnvironmentAction, string> = {
  "environment-create": "Allocate a fresh child Core with separate users, data, ports and the shared Docker engine. No workspace is required. Supply label, requestId, mode current (prepared parent build), release (installed parent binary) or source (absolute Core projectPath). Does not start it. No production credentials or data are copied.",
  "environment-list": "List this session's child Core environments; also recovers associations after an uncertain create response.",
  "environment-status": "Observe environmentId, revision, process identity, errors and local Core preview URL. Verify running before use.",
  "environment-start": "Start environmentId using requestId and expectedRevision. Source builds finish before launch; wait for running and inspect errors.",
  "environment-stop": "Stop child Core and its apps, preserving temporary data and users for continuation. Supply environmentId, requestId and expectedRevision.",
  "environment-restart": "Build then restart child Core without changing the parent or agent. Supply environmentId, requestId and expectedRevision. A failed source build preserves the previous child.",
  "environment-finish": "Finish and delete this environment's Core, apps, users, caches and temporary root, including resources left by a broken Core. Preserve review previews until the operator finishes. Supply environmentId, requestId and expectedRevision.",
  "environment-setup": "Explicitly initialize a fresh child through normal Core setup, or log in again with its existing credentials. Supply environmentId, email, displayName and password. Use test-only credentials. The child session remains private in Core; do not repeat passwords in messages or evidence.",
  "environment-api": "Call the selected child's ordinary JSON Core API after environment_setup: environmentId, method GET/POST/PUT/PATCH/DELETE, relative /api/ path, optional JSON body. Uses the child's password session, never the parent identity. API mutations have their own replay semantics; inspect state after timeouts. Redirects and streaming APIs are unsupported. External connections/publication need explicit operator authorization.",
};
export const coreEnvironmentTools = () => coreEnvironmentActions.map(action => ({ name: action.replaceAll("-", "_"), description: descriptions[action],
  inputSchema: { type: "object", properties: {
    ...Object.fromEntries(["environmentId", "requestId", "label", "projectPath", "email", "displayName", "password", "path", "workspaceId"].map(k => [k, { type: "string" }])),
    worktreeIds: { type: "array", items: { type: "string" }, maxItems: 16 },
    mode: { type: "string", enum: ["current", "release", "source"] }, expectedRevision: { type: "integer", minimum: 1 },
    method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, body: { type: "object", additionalProperties: true },
  }, additionalProperties: false },
  annotations: { readOnlyHint: action === "environment-list" || action === "environment-status", destructiveHint: action === "environment-finish", openWorldHint: action === "environment-api" },
}));
