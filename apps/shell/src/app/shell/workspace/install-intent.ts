export const INSTALL_FEED_INTENT_TYPE = "hosty:install-feed";
export const INSTALL_FEED_INTENT_VERSION = 1;

// The only app allowed to hand Shell a feed install intent. The workspace iframe engine is generic
// (it renders any runtime or system app), so source/origin validation alone would let any embedded
// app initiate an admin-reviewed install pointed at an attacker-chosen feed URL. Gating on the app
// id keeps the handshake Marketplace-only, matching the vertical-slice contract.
export const MARKETPLACE_APP_ID = "hosty.marketplace";

const MAX_FEEDS_URL_LENGTH = 4096;
const MAX_FEED_ID_LENGTH = 128;

// Whether the app currently shown in the workspace surface may send an install intent. Only the
// Marketplace system app qualifies; every other embedded app's message is ignored before parsing.
export function appMayRequestFeedInstall(appId: string): boolean {
  return appId === MARKETPLACE_APP_ID;
}

export type InstallFeedIntent = {
  feedsUrl: string;
  feedId: string | null;
};

export type InstallFeedMessage = {
  data: unknown;
  origin: string;
  source: unknown;
};

export function parseActiveFrameInstallFeedIntent(
  event: InstallFeedMessage,
  activeFrameWindow: unknown,
  activeFrameUrl: string,
): InstallFeedIntent | null {
  if (!activeFrameWindow || event.source !== activeFrameWindow) {
    return null;
  }

  try {
    if (event.origin !== new URL(activeFrameUrl).origin) {
      return null;
    }
  } catch {
    return null;
  }

  return parseInstallFeedIntent(event.data);
}

// An iframe message is untrusted even when it comes from the active app frame. Keep this parser
// deliberately narrow: the Shell accepts only the versioned install-feed intent and still sends it
// through Core's ordinary reviewed plan/apply flow. No lifecycle credential crosses the iframe.
export function parseInstallFeedIntent(value: unknown): InstallFeedIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as {
    type?: unknown;
    version?: unknown;
    feedsUrl?: unknown;
    feedId?: unknown;
  };
  if (candidate.type !== INSTALL_FEED_INTENT_TYPE || candidate.version !== INSTALL_FEED_INTENT_VERSION) {
    return null;
  }

  if (typeof candidate.feedsUrl !== "string") {
    return null;
  }

  if (candidate.feedsUrl.length > MAX_FEEDS_URL_LENGTH) {
    return null;
  }

  const feedsUrl = candidate.feedsUrl.trim();
  if (feedsUrl.length === 0 || !isSafeHttpUrl(feedsUrl)) {
    return null;
  }

  let feedId: string | null = null;
  if (candidate.feedId !== undefined) {
    if (typeof candidate.feedId !== "string") {
      return null;
    }

    if (candidate.feedId.length > MAX_FEED_ID_LENGTH) {
      return null;
    }

    feedId = candidate.feedId.trim();
    if (feedId.length === 0) {
      return null;
    }
  }

  return { feedsUrl, feedId };
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}
