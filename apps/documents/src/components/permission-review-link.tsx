"use client";

import type { MouseEvent } from "react";
import { PERMISSION_REVIEW_REQUEST } from "@hosty-sdk/app/permissions";

export function PermissionReviewLink({ href }: { href: string }) {
  function review(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button > 1 || window.parent === window) return;
    // The host verifies the sending frame and opens Core outside the app's sandbox.
    event.preventDefault();
    window.parent.postMessage({ type: PERMISSION_REVIEW_REQUEST }, "*");
  }

  return <a href={href} target="_blank" rel="noopener noreferrer" className="underline" onClick={review} onAuxClick={review}>
    Review Documents permissions
  </a>;
}
