export type MarketplaceOptions = {
  sourceUrl: string | null;
};

// Runtime configuration is resolved lazily by getRuntime(). Keeping this function free of module-level
// reads is important for `next build`, where Hosty-injected settings do not exist yet. The identity
// flow (host-auth.ts) reads HOSTY_APP_ID / HOSTY_CORE_ORIGIN / HOSTY_APP_SERVICE_TOKEN from the
// environment directly, so the only configuration this app owns is its single catalog source URL.
export function optionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): MarketplaceOptions {
  return {
    sourceUrl: readHttpUrl(env.HOSTY_MARKETPLACE_SOURCE_URL),
  };
}

function readString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readHttpUrl(value: string | undefined): string | null {
  const candidate = readString(value);
  if (!candidate) {
    return null;
  }

  try {
    const url = new URL(candidate);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}
