"use client";

import { DynamicIcon, iconNames } from "lucide-react/dynamic.mjs";
import { SdkIcon } from "./sdk-chrome";

const normalize = (name: string) => name.replace(/[-_\s]/g, "").toLowerCase();
const names = new Map(iconNames.map(name => [normalize(name), name]));
const fallback = () => <SdkIcon name="tools" />;

/** Panel manifests carry Lucide names, including legacy component-name spellings. */
export function UiPanelIcon({ name }: { name: string | null }) {
  const icon = name ? names.get(normalize(name.trim())) : undefined;
  return icon ? <DynamicIcon key={icon} name={icon} fallback={fallback} className="hosty-sdk-icon" aria-hidden="true" focusable="false" /> : fallback();
}
