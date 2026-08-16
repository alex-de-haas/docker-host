// The pure vocabulary of an endpoint's public origin: the setting key Core reads it from, and the shape
// of a subdomain label. Split out of settings.tsx so it is importable from a `node --test` file — the
// runner strips types from `.ts` but cannot transform JSX — and so the control and the settings form
// cannot drift apart on what a key looks like.

export const PUBLIC_ORIGIN_SETTING_PREFIX = "HOSTY_PUBLIC_ORIGIN_";

export function isPublicOriginSettingKey(key: string) {
  return key.startsWith(PUBLIC_ORIGIN_SETTING_PREFIX);
}

// Mirrors Core's RuntimePortHelper.NormalizeEnvironmentKey: uppercase, every non-alphanumeric to an
// underscore. A mismatch here would write a setting nothing ever reads back.
export function normalizePublicOriginEndpointKey(value: string) {
  const normalized = (value || "endpoint")
    .split("")
    .map((character) => /[a-zA-Z0-9]/.test(character) ? character.toUpperCase() : "_")
    .join("")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ENDPOINT";
}

export function buildPublicOriginSettingKey(endpointKey: string) {
  return `${PUBLIC_ORIGIN_SETTING_PREFIX}${normalizePublicOriginEndpointKey(endpointKey)}`;
}

export function getPublicOriginEndpointLabel(key: string) {
  if (!isPublicOriginSettingKey(key)) {
    return "";
  }

  return key.slice(PUBLIC_ORIGIN_SETTING_PREFIX.length).toLowerCase().replaceAll("_", ".");
}

// Lowercase, and only what a DNS label may contain. Both label-shaped providers share it, which is what
// makes them feel like one control rather than two that happen to look alike.
export function sanitizeSubdomainLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

// What the one primary button does for an endpoint that is already published, and whether it does
// anything at all. The dialog prefills the field with the publication's own label, so "unchanged" is the
// resting state and the two actions are the same POST under different labels:
//
//   unchanged + drifted   → Reapply. The repair the drift message asks for: re-applying the same label
//                           re-points the route at the endpoint's current local URL, idempotent for the
//                           hostname and the DNS record.
//   unchanged + anything  → nothing to press. Republishing an intact publication is a no-op.
//   edited                → Rename. Core removes the old route in the same tunnel-config PUT and renames
//                           the DNS record in place, so the hostname never stops resolving. That is why
//                           this is one action and not unpublish-then-publish, which would delete the
//                           record and, for an adopted one, orphan it.
//
// The verb stays "Rename" whenever the label is not exactly the published one — including while the field
// is empty — so the button reads as the affordance for editing rather than appearing out of nowhere.
export function resolvePublishedLabelAction(publishedLabel: string, typedLabel: string, state: string) {
  const next = sanitizeSubdomainLabel(typedLabel.trim());
  if (next === sanitizeSubdomainLabel(publishedLabel.trim())) {
    return { action: "reapply", enabled: state === "origin_drifted" } as const;
  }

  return { action: "rename", enabled: next.length > 0 } as const;
}
