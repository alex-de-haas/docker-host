"use client";

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";

/** Shared SDK chrome for sign-in and renewal, independent of the app's CSS framework. */
export function AuthNotice({ children }: { children: ReactNode }) {
  return <div data-hosty-activity-control role="status" style={barStyle}>{children}</div>;
}

export function AuthNoticeButton({ secondary = false, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return <button {...props} type="button" disabled={disabled} style={{
    ...authNoticeActionStyle,
    ...(secondary ? { background: "transparent", color: "#422006", boxShadow: "inset 0 0 0 1px #a16207" } : {}),
    ...(disabled ? { opacity: 0.65, cursor: "wait" } : {}),
  }} />;
}

const barStyle: CSSProperties = {
  position: "fixed",
  insetInline: 0,
  bottom: 0,
  zIndex: 2147483647,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "center",
  gap: "12px",
  padding: "12px 16px",
  margin: 0,
  border: 0,
  borderTop: "1px solid #d97706",
  boxSizing: "border-box",
  background: "#fef3c7",
  color: "#422006",
  font: "500 14px/1.4 system-ui, sans-serif",
  textAlign: "center",
  boxShadow: "0 -2px 8px rgba(66,32,6,0.12)",
};

export const authNoticeActionStyle: CSSProperties = {
  display: "inline-block",
  padding: "6px 14px",
  margin: 0,
  borderRadius: "8px",
  background: "#422006",
  color: "#fffbeb",
  border: "none",
  cursor: "pointer",
  font: "650 14px/1.4 system-ui, sans-serif",
  textDecoration: "none",
  textTransform: "none",
  letterSpacing: "normal",
};
