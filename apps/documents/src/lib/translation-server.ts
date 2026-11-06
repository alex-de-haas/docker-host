import "server-only";
import { createHash } from "node:crypto";
import { ProviderError, type ProviderDescriptor } from "@hosty-sdk/app/providers";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { getAppId, getCorePublicOrigin } from "@hosty-sdk/app/server";
import { permissionReviewUrl } from "@hosty-sdk/app/permissions";
import { config, DocumentsError, requireAdministratorIdentity, requireSameOriginJson } from "./auth";
import { CoreSourceReader } from "./core-client";
import { translationBody, validTargetLanguage, type TranslationChoice, type TranslationInput } from "./translation";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const limit = 128_000;
function choice(provider: ProviderDescriptor): TranslationChoice {
  return { appId: provider.appId, key: provider.key, installationId: provider.installationId ?? "", displayName: provider.displayName,
    problem: !provider.available ? "This translator is not running."
      : provider.version !== 1 || !provider.capabilities.includes("markdown") ? "This translator does not support Markdown version 1."
      : !provider.installationId ? "Update Core to identify the translator installation." : null };
}
function failure(error: unknown): Response {
  const known = error instanceof DocumentsError || error instanceof ProviderError;
  const denied = error instanceof ProviderError && error.code === "app_permission_required";
  const core = getCorePublicOrigin();
  return Response.json({ code: known ? error.code : "translation_unavailable",
    message: denied ? "Allow Documents to use Translation in Core, then try again."
      : known ? error.message : "Translation could not be completed. The original document is unchanged.",
    ...(denied && core ? { reviewUrl: permissionReviewUrl(core, getAppId(config)) } : {}) },
  { status: known ? error.status : error instanceof SyntaxError ? 400 : 502, headers });
}
export async function translationOptions(request: Request) {
  try {
    const actor = await requireAdministratorIdentity(request.headers);
    const client = new ProviderClient({ appId: getAppId(config) });
    const providers = await client.list("translation", request.signal);
    const choices = await Promise.all(providers.map(async provider => {
      const result = choice(provider);
      if (result.problem) return result;
      try {
        const capabilities = await client.translationCapabilities(provider, request.signal);
        result.problem = !capabilities.ready ? capabilities.reason ?? "The selected translator is not ready. Check its configuration and logs."
          : !capabilities.formats.includes("markdown") ? "This translator does not support Markdown." : null;
      } catch { result.problem = "This translator is unavailable. Check its status and logs in Core."; }
      return result;
    }));
    return Response.json({ userId: actor.userId, providers: choices }, { headers });
  } catch (error) { return failure(error); }
}
function parseInput(value: unknown): TranslationInput {
  const input = value as Partial<TranslationInput> | null;
  if (!input || typeof input.repositoryId !== "string" || !input.repositoryId || input.repositoryId.length > 256 ||
      typeof input.path !== "string" || input.path.length > 2048 || !/^docs\/.+\.md$/.test(input.path) ||
      /[\\\x00-\x1f]/.test(input.path) || input.path.split("/").some(part => !part || part === "." || part === "..") ||
      (input.workspaceId !== null && (typeof input.workspaceId !== "string" || !input.workspaceId || input.workspaceId.length > 256)) ||
      typeof input.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.contentHash) ||
      typeof input.providerAppId !== "string" || !input.providerAppId || input.providerAppId.length > 256 ||
      typeof input.installationId !== "string" || !input.installationId || input.installationId.length > 256 ||
      typeof input.key !== "string" || !input.key || input.key.length > 100 || !validTargetLanguage(input.targetLanguage))
    throw new DocumentsError("Select a document, translator and target language.", 400, "invalid_translation");
  return input as TranslationInput;
}
export async function translateDocument(request: Request) {
  try {
    requireSameOriginJson(request, "Start translation from this Documents page.");
    const actor = await requireAdministratorIdentity(request.headers);
    const body = await request.text();
    if (body.length > 8192) throw new DocumentsError("The translation request is too large.", 413, "invalid_translation");
    const input = parseInput(JSON.parse(body));
    const client = new ProviderClient({ appId: getAppId(config) });
    const provider = (await client.list("translation", request.signal)).find(p => p.appId === input.providerAppId && p.key === input.key);
    if (!provider || choice(provider).problem) throw new DocumentsError("The selected translator is unavailable.", 409, "translation_unavailable");
    if (provider.installationId !== input.installationId) throw new DocumentsError("The translator was reinstalled. Select it again.", 409, "provider_changed");
    const reader = new CoreSourceReader(actor.token, request.signal);
    const repository = (await reader.repositories()).find(r => r.id === input.repositoryId);
    if (!repository) throw new DocumentsError("This repository is no longer accessible.", 404, "repository_not_found");
    if (input.workspaceId && !(await reader.workspaces(repository.id)).some(w => w.id === input.workspaceId))
      throw new DocumentsError("This workspace is no longer accessible.", 404, "workspace_not_found");
    const listing = await reader.listing(repository.id, input.workspaceId ? "worktree" : "target", input.workspaceId ?? undefined, false, input.path);
    if (listing.error) throw new DocumentsError(listing.error);
    const entry = listing.documents.find(d => d.path === input.path);
    if (!entry) throw new DocumentsError("This document version is unavailable or was deleted.", 404, "document_not_found");
    const file = await reader.content(repository.id, input.path, listing, entry.sha);
    if (file.path !== input.path || file.sha !== entry.sha || createHash("sha256").update(file.content).digest("hex") !== input.contentHash)
      throw new DocumentsError("The document changed. Refresh sources and translate its current version.", 409, "document_changed");
    if ([...file.content].length > limit) throw new DocumentsError("Translation supports documents up to 128,000 characters.", 413, "translation_too_large");
    request.signal.throwIfAborted();
    const result = await client.translate(provider, { text: file.content, format: "markdown", targetLanguage: input.targetLanguage }, request.signal);
    // Provider validation protects Markdown; display only its prose body without reparsing translated workflow headings.
    return Response.json({ body: translationBody(result.text), contentHash: input.contentHash, targetLanguage: result.targetLanguage,
      providerAppId: provider.appId, key: provider.key }, { headers });
  } catch (error) { return failure(error); }
}
