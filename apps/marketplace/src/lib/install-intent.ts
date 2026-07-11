import { getEmbeddingOrigin, resolveEmbeddingOrigin } from "@/lib/embedding-origin";

export { resolveEmbeddingOrigin };

export const INSTALL_FEED_INTENT_TYPE = "hosty:install-feed";
export const INSTALL_FEED_INTENT_VERSION = 1;

export type InstallFeedIntent = {
  type: typeof INSTALL_FEED_INTENT_TYPE;
  version: typeof INSTALL_FEED_INTENT_VERSION;
  feedsUrl: string;
  feedId?: string;
};

export type InstallIntentResult =
  | { ok: true }
  | { ok: false; message: string };

export function createInstallFeedIntent(feedsUrl: string, feedId?: string | null): InstallFeedIntent {
  const normalizedUrl = normalizeHttpUrl(feedsUrl);
  if (!normalizedUrl) {
    throw new Error("This app does not provide a valid HTTP(S) feed URL.");
  }

  const normalizedFeedId = normalizeFeedId(feedId);
  return normalizedFeedId
    ? { type: INSTALL_FEED_INTENT_TYPE, version: INSTALL_FEED_INTENT_VERSION, feedsUrl: normalizedUrl, feedId: normalizedFeedId }
    : { type: INSTALL_FEED_INTENT_TYPE, version: INSTALL_FEED_INTENT_VERSION, feedsUrl: normalizedUrl };
}

export function postInstallFeedIntent(feedsUrl: string, feedId?: string | null): InstallIntentResult {
  if (window.parent === window) {
    return { ok: false, message: "Install review is available only when Marketplace is opened inside Hosty Shell." };
  }

  const targetOrigin = getEmbeddingOrigin();
  if (!targetOrigin) {
    return { ok: false, message: "The embedding Hosty Shell origin could not be determined." };
  }

  try {
    window.parent.postMessage(createInstallFeedIntent(feedsUrl, feedId), targetOrigin);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The install request could not be sent to Hosty Shell.",
    };
  }
}

function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function normalizeFeedId(value?: string | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new Error("The selected feed id must contain 1 to 128 characters.");
  }
  return trimmed;
}
