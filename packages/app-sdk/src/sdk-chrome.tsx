"use client";

import { useEffect, type CSSProperties } from "react";
import { CoreMark } from "./chrome-mark";

// Statically analyzable URLs work in workspace bundlers and the published dist alike.
const sansLatin = new URL("./assets/plex-sans-latin.woff2", import.meta.url).href;
const sansExtended = new URL("./assets/plex-sans-latin-ext.woff2", import.meta.url).href;
const sansCyrillic = new URL("./assets/plex-sans-cyrillic.woff2", import.meta.url).href;
const monoLatin = new URL("./assets/jetbrains-mono-latin.woff2", import.meta.url).href;
const monoExtended = new URL("./assets/jetbrains-mono-latin-ext.woff2", import.meta.url).href;
const monoCyrillic = new URL("./assets/jetbrains-mono-cyrillic.woff2", import.meta.url).href;

type FontOwner = { element: HTMLStyleElement; users: number };
const fontOwners = new WeakMap<Document, FontOwner>();

function retainFonts(document: Document) {
  let owner = fontOwners.get(document);
  if (!owner?.element.isConnected) {
    const element = document.createElement("style");
    element.dataset.hostySdkFonts = "";
    element.textContent = fontStyles;
    document.head.append(element);
    owner = { element, users: 0 };
    fontOwners.set(document, owner);
  }
  const retained = owner;
  retained.users++;
  return () => {
    retained.users--;
    // StrictMode and a moving access portal can replay effects before the next paint.
    // Keep the same font sheet when another SDK surface acquires it in that interval.
    queueMicrotask(() => {
      if (retained.users !== 0) return;
      retained.element.remove();
      if (fontOwners.get(document) === retained) fontOwners.delete(document);
    });
  };
}

export function SdkChromeStyles() {
  // Asset URLs differ between Node SSR and the browser bundle. The deterministic base
  // style hydrates unchanged; only a mounted browser owner installs resolved font URLs.
  useEffect(() => retainFonts(document), []);
  return <style data-hosty-sdk-styles>{chromeStyles}</style>;
}
export function SdkBrand() { return <span className="hosty-sdk-brand"><CoreMark />Hosty</span>; }
export function SdkSpinner() { return <span className="hosty-sdk-spinner" aria-hidden="true" />; }
export function SdkProgress({ label }: { label: string }) {
  return <div className="hosty-sdk-progress" role="progressbar" aria-label={label}><span /></div>;
}
export function SdkLoader() {
  return <svg className="hosty-sdk-loader" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    {[[12,12],[12,41],[12,70],[41,41],[70,70],[70,41],[70,12]].map(([x,y], index) =>
      <rect key={index} x={x} y={y} width="18" height="18" style={{ "--hosty-cell-delay": `${index * .16}s` } as CSSProperties} />)}
  </svg>;
}
type Icon = "close" | "external" | "menu" | "plus" | "minus" | "check" | "warning" | "error";
const paths: Record<Icon,string> = {
  close: "m18 6-12 12M6 6l12 12", external: "M15 3h6v6m0-6L10 14m8-1v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  menu: "M4 6h16M4 12h16M4 18h16", plus: "M12 5v14M5 12h14", minus: "M5 12h14", check: "m20 6-11 11-5-5",
  warning: "m12 3 9 9-9 9-9-9 9-9Zm0 4v6m0 3v.01", error: "M12 8v4m0 4v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
};
export function SdkIcon({ name }: { name: Icon }) {
  return <svg className="hosty-sdk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}

// These roots contain SDK chrome only. Layout ancestors and the app document are deliberately absent.
const fontStyles = `
@font-face{font-family:"Hosty SDK Sans";font-style:normal;font-weight:100 900;font-display:swap;src:url("${sansLatin}") format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Hosty SDK Sans";font-style:normal;font-weight:100 900;font-display:swap;src:url("${sansExtended}") format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Hosty SDK Sans";font-style:normal;font-weight:100 900;font-display:swap;src:url("${sansCyrillic}") format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:"Hosty SDK Mono";font-style:normal;font-weight:100 800;font-display:swap;src:url("${monoLatin}") format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Hosty SDK Mono";font-style:normal;font-weight:100 800;font-display:swap;src:url("${monoExtended}") format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Hosty SDK Mono";font-style:normal;font-weight:100 800;font-display:swap;src:url("${monoCyrillic}") format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
`;

export const chromeStyles = `
[data-hosty-sdk]{--hs-font:"Hosty SDK Sans","IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;--hs-mono:"Hosty SDK Mono","JetBrains Mono",ui-monospace,monospace;--hs-bg:#F6F8FB;--hs-card:#FFFFFF;--hs-fg:#0F1B2D;--hs-muted:#5A6A82;--hs-border:#DFE5EE;--hs-input:#C3CDDB;--hs-soft:#EEF2F7;--hs-action:#0F1B2D;--hs-action-fg:#FFFFFF;--hs-brand:#A3E635;--hs-brand-fg:#0F1B2D;--hs-brand-soft:#ECFCCB;--hs-brand-edge:#5A9A0A;--hs-info:#1449C2;--hs-info-solid:#1C68FF;--hs-info-soft:#E8F0FF;--hs-warning:#8A5300;--hs-warning-soft:#FEF3DC;--hs-warning-border:#F8D9A0;--hs-danger:#B4232A;--hs-danger-soft:#FDECEC;--hs-success:#0F6B33;--hs-success-soft:#E8F7EE;color-scheme:light;color:var(--hs-fg);font:400 14px/1.5 var(--hs-font);letter-spacing:normal;text-transform:none;box-sizing:border-box}
html.dark [data-hosty-sdk],html[data-hosty-theme=dark] [data-hosty-sdk]{--hs-bg:#0F1B2D;--hs-card:#17253B;--hs-fg:#F6F8FB;--hs-muted:#93A3BA;--hs-border:#26364F;--hs-input:#3A4B66;--hs-soft:#22324B;--hs-action:#F6F8FB;--hs-action-fg:#0F1B2D;--hs-brand-soft:#273B2E;--hs-brand-edge:#A3E635;--hs-info:#8DB4FF;--hs-info-solid:#4D8BFF;--hs-info-soft:#182E50;--hs-warning:#FBBF24;--hs-warning-soft:#392E22;--hs-warning-border:#6A4C22;--hs-danger:#FF8A8E;--hs-danger-soft:#3A2432;--hs-success:#4ADE80;--hs-success-soft:#18392F;color-scheme:dark}
[data-hosty-sdk] :where(button,input,select,textarea){font:inherit;letter-spacing:normal;text-transform:none;box-sizing:border-box}
[data-hosty-sdk] :where(button,a,input,select,textarea,summary,[tabindex]):focus-visible{outline:2px solid var(--hs-brand);outline-offset:2px;box-shadow:none}
[data-hosty-sdk] :where(input,select,textarea)[aria-invalid=true]:focus-visible{outline-color:var(--hs-danger)}
[data-hosty-sdk] ::selection{background:var(--hs-brand);color:var(--hs-brand-fg)}
[data-hosty-sdk] .hosty-sdk-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;box-sizing:border-box;min-height:36px;padding:7px 12px;border:1px solid var(--hs-input);border-radius:8px;background:var(--hs-card);color:var(--hs-fg);font:500 14px/20px var(--hs-font);text-decoration:none;cursor:pointer;transition:background-color 120ms ease-out,color 120ms ease-out,border-color 120ms ease-out;white-space:normal;text-align:center}
[data-hosty-sdk] .hosty-sdk-primary{background:var(--hs-action);border-color:var(--hs-action);color:var(--hs-action-fg)}
[data-hosty-sdk] .hosty-sdk-ghost{background:transparent;border-color:transparent}
[data-hosty-sdk] .hosty-sdk-danger{color:var(--hs-danger)}
[data-hosty-sdk] .hosty-sdk-button:hover:not(:disabled){background:var(--hs-brand);border-color:var(--hs-brand);color:var(--hs-brand-fg)}
[data-hosty-sdk] .hosty-sdk-button:active:not(:disabled){background:var(--hs-brand-soft);border-color:var(--hs-brand-edge);color:var(--hs-fg)}
[data-hosty-sdk] .hosty-sdk-button:disabled{opacity:.5;cursor:not-allowed}
[data-hosty-sdk] .hosty-sdk-icon-button{flex:none;width:32px;min-height:32px;padding:6px}
[data-hosty-sdk] .hosty-sdk-input{box-sizing:border-box;width:100%;min-height:36px;padding:7px 10px;border:1px solid var(--hs-input);border-radius:8px;background:var(--hs-card);color:var(--hs-fg);font:400 14px/20px var(--hs-font)}
.hosty-sdk-brand{display:inline-flex;align-items:center;gap:6px;flex:none;font:500 12px/18px var(--hs-font);color:var(--hs-muted)}
.hosty-sdk-brand>svg{display:block;width:18px;height:18px;color:var(--hs-fg);flex:none}
.hosty-sdk-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.hosty-sdk-icon{display:block;width:16px;height:16px;flex:none}
.hosty-sdk-spinner{display:inline-block;flex:none;width:16px;height:16px;box-sizing:border-box;border:2px solid var(--hs-input);border-top-color:var(--hs-info-solid);border-radius:50%;animation:hosty-sdk-spin .8s linear infinite}
.hosty-sdk-progress{height:4px;border-radius:4px;background:var(--hs-soft);overflow:hidden;width:100%}
.hosty-sdk-progress>span{display:block;width:38%;height:100%;border-radius:inherit;background:var(--hs-brand);animation:hosty-sdk-progress 1.6s ease-in-out infinite}
.hosty-sdk-loader{display:block;width:36px;height:36px}
.hosty-sdk-loader rect{fill:var(--hs-card);stroke:var(--hs-input);stroke-width:3;animation:hosty-sdk-cell 1.6s ease-in-out infinite;animation-delay:var(--hosty-cell-delay)}
.hosty-sdk-status{display:flex;align-items:center;gap:8px;color:var(--hs-muted)}
.hosty-panel-notice[data-hosty-sdk]{padding:24px;background:var(--hosty-panel-background,var(--hs-bg));color:var(--hosty-panel-foreground,var(--hs-fg));overflow-wrap:anywhere}.hosty-panel-notice[data-hosty-sdk] p{margin:8px 0;color:var(--hosty-panel-muted,var(--hs-muted))}.hosty-panel-notice[data-hosty-sdk] a{color:var(--hs-info);text-decoration:underline;text-underline-offset:3px}
.hosty-panel-review[data-hosty-sdk]{position:absolute;top:8px;right:8px;z-index:2;padding:8px 12px;border:1px solid var(--hosty-panel-border,var(--hs-input));border-radius:8px;background:var(--hosty-panel-background,var(--hs-card));color:var(--hosty-panel-foreground,var(--hs-fg));font:500 13px/20px var(--hs-font);text-decoration:none}.hosty-panel-review[data-hosty-sdk]:hover{background:var(--hs-brand-soft)}.hosty-panel-review[data-hosty-sdk]:focus-visible{outline:2px solid var(--hs-brand);outline-offset:2px}
@keyframes hosty-sdk-spin{to{transform:rotate(360deg)}}
@keyframes hosty-sdk-progress{0%{transform:translateX(-110%)}100%{transform:translateX(370%)}}
@keyframes hosty-sdk-cell{0%,55%,100%{fill:var(--hs-card);stroke:var(--hs-input)}18%{fill:var(--hs-brand);stroke:var(--hs-brand-edge)}}
@media(prefers-reduced-motion:reduce){.hosty-sdk-spinner,.hosty-sdk-progress>span,.hosty-sdk-loader rect{animation:none}.hosty-sdk-spinner{border-color:var(--hs-info-solid);outline:1px solid var(--hs-info-solid);outline-offset:2px}.hosty-sdk-progress>span{width:100%;opacity:.7}.hosty-sdk-loader rect:nth-child(4){fill:var(--hs-brand);stroke:var(--hs-brand-edge)}}
@media(max-width:480px){[data-hosty-sdk] .hosty-sdk-input{font-size:16px}}
`;
