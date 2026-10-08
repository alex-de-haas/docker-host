"use client";

import { HostyOverlay } from "@hosty-sdk/app/react";
import { Storefront } from "./storefront";

export function MarketplaceSession() {
  return <HostyOverlay><Storefront /></HostyOverlay>;
}
