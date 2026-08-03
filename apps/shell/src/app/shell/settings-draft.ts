import type { CoreSetting } from "./types";

// The editable state of the app settings form. A secret's entry is `null` for as long as the operator
// has not touched its field; every other entry -- and a touched secret -- holds the exact string to
// submit.
//
// The distinction matters because Core merges a configure payload key by key: a secret the payload
// omits keeps its stored value, which is what the "Unchanged" placeholder promises. Collapsing
// "untouched" and "emptied" onto the same empty string would make a stored secret impossible to
// delete, because the write that deletes it is precisely an empty one.
export type AppSettingsDraft = Record<string, string | null>;

export function buildAppSettingsDraft(settings: CoreSetting[]): AppSettingsDraft {
  return Object.fromEntries(settings.map((setting) => [setting.key, setting.secret ? null : setting.value || ""]));
}

// Turn the draft into a configure payload. An untouched secret is left out so Core keeps what it has;
// a touched one is submitted verbatim, so emptying the field clears the stored value. A cleared
// setting is sent as "" rather than null because Core reapplies the manifest default over a null on
// the next rebuild (install/update/runtime switch), while an empty string stays empty.
export function buildAppSettingsPayload(settings: CoreSetting[], draft: AppSettingsDraft): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const setting of settings) {
    const value = draft[setting.key];
    if (setting.secret && (value === null || value === undefined)) {
      continue;
    }

    payload[setting.key] = value ?? "";
  }

  return payload;
}

// What a secret's input renders, decided from its draft entry, the reveal toggle, and the value
// fetched for a revealed untouched field.
export type SecretFieldState = {
  displayValue: string;
  placeholder: string;
  // Whether the stored value is worth fetching: there is one, it is not in hand, and the field is
  // untouched so it has somewhere to go. Deliberately independent of `revealed` -- the caller reads
  // this while turning reveal on, when its own `revealed` still holds the pre-toggle value.
  shouldFetchStored: boolean;
};

// Install-time settings never carry hasValue -- nothing is stored yet -- so they read "Not set" until
// the operator types something. Only app summaries, which always carry the flag, reach the other two.
const UNCHANGED_PLACEHOLDER = "Unchanged";
const UNSET_PLACEHOLDER = "Not set";
const CLEARING_PLACEHOLDER = "Will be cleared on save";

export function resolveSecretFieldState({ draftValue, hasStored, revealed, stored }: {
  draftValue: string | null;
  hasStored: boolean;
  revealed: boolean;
  stored: string | null;
}): SecretFieldState {
  // A touched field belongs to the operator: it renders their input verbatim, the empty string
  // included. Standing the stored value back in whenever the draft reads empty -- the rule this
  // replaced -- made a revealed secret impossible to delete, because deleting the last character
  // restored the whole value, every time.
  if (draftValue !== null) {
    return {
      displayValue: draftValue,
      // An emptied field is a pending delete, not a no-op, so say so where "Unchanged" promised the
      // opposite.
      placeholder: draftValue.length === 0 && hasStored ? CLEARING_PLACEHOLDER : hasStored ? UNCHANGED_PLACEHOLDER : UNSET_PLACEHOLDER,
      shouldFetchStored: false,
    };
  }

  return {
    displayValue: revealed && stored !== null ? stored : "",
    placeholder: hasStored ? UNCHANGED_PLACEHOLDER : UNSET_PLACEHOLDER,
    shouldFetchStored: hasStored && stored === null,
  };
}
