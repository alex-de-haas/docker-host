"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { LanguagesIcon, LoaderCircleIcon } from "lucide-react";
import type { ParsedDocument } from "@/lib/types";
import { TRANSLATION_LANGUAGES, validTargetLanguage, type PlanTranslation, type TranslationOptions } from "@/lib/translation";
import { SourceDocument } from "./document";
import { PermissionReviewLink } from "./permission-review-link";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Props = { document: ParsedDocument; repositoryId: string; workspaceId: string | null; navigate: (url: string) => void };
type Failure = { message: string; reviewUrl?: string };
async function responseBody<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw body;
  return body as T;
}
function failure(error: unknown): Failure {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error as Failure : { message: "Translation could not be completed. Try again." };
}
export function TranslateDocument(props: Props) {
  const hash = useMemo(() => Array.from(sha256(new TextEncoder().encode(props.document.content)), byte => byte.toString(16).padStart(2, "0")).join(""), [props.document.content]);
  // Source/version changes abort pending work and discard old translations; unchanged polling retains the view.
  return <TranslationView key={JSON.stringify([props.repositoryId, props.document.path, props.workspaceId, hash])} {...props} contentHash={hash} />;
}
function TranslationView({ document, repositoryId, workspaceId, navigate, contentHash }: Props & { contentHash: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [options, setOptions] = useState<TranslationOptions | null>(null);
  const [selection, setSelection] = useState("");
  const [language, setLanguage] = useState("ru");
  const [customLanguage, setCustomLanguage] = useState("");
  const [error, setError] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [translated, setTranslated] = useState<(PlanTranslation & { label: string; providerName: string }) | null>(null);
  const [showTranslation, setShowTranslation] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let busy = false;
    const load = () => {
      if (busy) return;
      busy = true; setLoading(true);
      void appFetch("/api/translation", { signal: controller.signal, cache: "no-store" }).then(responseBody<TranslationOptions>)
        .then(value => { if (!controller.signal.aborted) { setOptions(value); setError(null); } })
        .catch(cause => { if (!controller.signal.aborted) { setOptions(null); setError(failure(cause)); } })
        .finally(() => { busy = false; if (!controller.signal.aborted) setLoading(false); });
    };
    load(); window.addEventListener("focus", load);
    return () => { controller.abort(); window.removeEventListener("focus", load); };
  }, [expanded, epoch]);
  const choices = options?.providers ?? [];
  const available = choices.filter(p => !p.problem);
  const selected = choices.find(p => JSON.stringify([p.appId, p.key, p.installationId]) === selection)
    ?? (!selection && available.length === 1 ? available[0] : undefined);
  const targetLanguage = language === "custom" ? customLanguage.trim() : language;
  const languageLabel = TRANSLATION_LANGUAGES.find(([code]) => code === targetLanguage)?.[1] ?? targetLanguage;
  const tooLarge = [...document.content].length > 128_000;
  async function translate() {
    if (running.current || !selected || selected.problem || !validTargetLanguage(targetLanguage) || tooLarge) return;
    const controller = new AbortController();
    running.current = controller; setPending(true); setError(null);
    try {
      const result = await appFetch("/api/translation", { method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repositoryId, path: document.path, workspaceId,
          contentHash, providerAppId: selected.appId, installationId: selected.installationId, key: selected.key, targetLanguage }) }).then(responseBody<PlanTranslation>);
      if (controller.signal.aborted) return;
      if (result.contentHash !== contentHash || result.targetLanguage !== targetLanguage || result.providerAppId !== selected.appId || result.key !== selected.key)
        throw new Error("The translation does not match this document. Try again.");
      setTranslated({ ...result, label: languageLabel, providerName: `${selected.displayName} (${selected.key})` }); setShowTranslation(true);
    } catch (cause) { if (!controller.signal.aborted) setError(failure(cause)); }
    finally { if (running.current === controller) { running.current = null; setPending(false); } }
  }
  function cancel() { running.current?.abort(); running.current = null; setPending(false); }
  return <div className="flex min-w-0 flex-col gap-4">
    <section aria-label="Document translation" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}><LanguagesIcon data-icon="inline-start" />Translate</Button>
        {translated && <><Button variant="ghost" size="sm" onClick={() => setShowTranslation(value => !value)}>{showTranslation ? "Show original" : "Show translation"}</Button>
          <span role="status" className="text-xs text-muted-foreground">{showTranslation ? `${translated.label} · ${translated.providerName}` : "Original document"}</span></>}
      </div>
      {expanded && <div id={id} className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs font-medium">Translator
            <select aria-label="Translation provider" className="h-9 rounded-md border bg-background px-2 text-sm" value={selected ? JSON.stringify([selected.appId, selected.key, selected.installationId]) : ""} disabled={pending || loading} onChange={event => setSelection(event.target.value)}>
              <option value="">{loading ? "Loading translators…" : "Choose translator"}</option>
              {choices.map(p => <option key={`${p.appId}:${p.key}`} value={JSON.stringify([p.appId, p.key, p.installationId])} disabled={!!p.problem}>{p.displayName} ({p.key}){p.problem ? " — unavailable" : ""}</option>)}
            </select>
          </label>
          <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs font-medium">Translate to
            <select aria-label="Translation language" className="h-9 rounded-md border bg-background px-2 text-sm" value={language} disabled={pending} onChange={event => setLanguage(event.target.value)}>
              {TRANSLATION_LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}<option value="custom">Other language…</option>
            </select>
          </label>
          {language === "custom" && <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs font-medium">Language code
            <Input aria-label="Target language code" placeholder="e.g. ko or zh-Hant" value={customLanguage} disabled={pending} maxLength={63} onChange={event => setCustomLanguage(event.target.value)} />
          </label>}
          <Button disabled={pending || loading || !selected || !!selected.problem || !validTargetLanguage(targetLanguage) || tooLarge} onClick={() => void translate()} aria-busy={pending}>
            {pending && <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />}{pending ? "Translating…" : "Translate document"}
          </Button>
          {pending && <Button variant="outline" onClick={cancel}>Cancel translation</Button>}
        </div>
        <p className="text-xs text-muted-foreground">Connection and model: Harness → Settings → Providers → Translation providers. Translation changes only this reading view.</p>
        {tooLarge && <p role="status" className="text-xs text-muted-foreground">This document exceeds the 128,000-character translation limit.</p>}
        {!loading && options && !choices.length && <p role="status" className="text-xs text-muted-foreground">No translation provider is installed.</p>}
        {!loading && choices.filter(p => p.problem).map(p => <p key={`${p.appId}:${p.key}`} className="text-xs text-muted-foreground">{p.displayName} ({p.key}): {p.problem}</p>)}
        {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive"><span>{error.message}</span>
          {error.reviewUrl && <PermissionReviewLink href={error.reviewUrl} />}
        </div>}
        {!pending && <Button variant="link" size="sm" className="self-start" onClick={() => setEpoch(value => value + 1)}>Refresh translators</Button>}
      </div>}
    </section>
    <SourceDocument workspaceId={workspaceId} document={document} body={showTranslation ? translated?.body : undefined} repositoryId={repositoryId} navigate={navigate} />
  </div>;
}
