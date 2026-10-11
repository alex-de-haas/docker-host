"use client";

import { HostyNextOverlay as HostyOverlay } from "@hosty-sdk/app/next";
import { Storefront } from "./storefront";

export function MarketplaceSession() {
  return <HostyOverlay><Storefront /></HostyOverlay>;
}
