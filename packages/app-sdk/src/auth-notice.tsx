"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { SdkBrand, SdkChromeStyles, SdkSpinner } from "./sdk-chrome";

/** Shared SDK chrome for sign-in and renewal, independent of the app's CSS framework. */
export function AuthNotice({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return <div data-hosty-sdk data-hosty-activity-control className="hosty-auth-notice" role="status" aria-busy={busy}>
    <SdkChromeStyles /><style>{styles}</style><SdkBrand />
    {busy && <SdkSpinner />}<div className="hosty-auth-notice-content">{children}</div>
  </div>;
}

export function AuthNoticeButton({ secondary = false, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return <button {...props} type="button" className={`hosty-sdk-button ${secondary ? "" : "hosty-sdk-primary"} ${className}`} />;
}

const styles = `
.hosty-auth-notice{position:fixed;inset-inline:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483647;display:flex;align-items:center;flex-wrap:wrap;gap:12px;box-sizing:border-box;margin:0;padding:12px 16px;border:1px solid var(--hs-warning-border);border-radius:10px;background:var(--hs-card);color:var(--hs-fg);box-shadow:0 4px 14px -4px #0F1B2D29;text-align:left}
.hosty-auth-notice-content{flex:1;display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;min-width:0}
.hosty-auth-notice-content>span{flex:1;min-width:min(100%,200px)}
@media(max-width:480px){.hosty-auth-notice{inset-inline:8px;padding:12px}.hosty-auth-notice-content{flex-basis:100%}}
`;
