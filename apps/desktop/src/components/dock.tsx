"use client";
import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";

type TooltipTarget = { button: HTMLButtonElement; root: HTMLElement; id: string; label: string; hint?: string };
const DockContext = createContext<{ active: TooltipTarget | null; setActive: Dispatch<SetStateAction<TooltipTarget | null>> } | null>(null);

export function Dock({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<TooltipTarget | null>(null);
  return <DockContext.Provider value={{ active, setActive }}>
    <nav className="dock-wrap" aria-label="Application dock"><div className="dock">{children}</div></nav>
    {active && <DockTooltip target={active} dismiss={() => setActive(null)} />}
  </DockContext.Provider>;
}

export function DockButton({ label, hint, children, onPointerEnter, onPointerLeave, onFocus, onBlur, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; hint?: string }) {
  const dock = useContext(DockContext), id = useId(), setActive = dock?.setActive;
  useLayoutEffect(() => () => setActive?.(current => current?.id === id ? null : current), [id, setActive]);
  if (!dock) throw new Error("DockButton requires a Dock.");
  const show = (button: HTMLButtonElement) => {
    const root = button.closest<HTMLElement>(".desktop");
    if (root) dock.setActive({ button, root, id, label, hint });
  };
  const hide = (button: HTMLButtonElement) => dock.setActive(current => current?.button === button ? null : current);
  return <button {...props} aria-describedby={dock.active?.id === id ? id : undefined}
    onPointerEnter={event => { if (event.pointerType !== "touch") show(event.currentTarget); onPointerEnter?.(event); }}
    onPointerLeave={event => { if (!event.currentTarget.matches(":focus-visible")) hide(event.currentTarget); onPointerLeave?.(event); }}
    onFocus={event => { if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget); onFocus?.(event); }}
    onBlur={event => { if (!event.currentTarget.matches(":hover")) hide(event.currentTarget); onBlur?.(event); }}>
    {children}
  </button>;
}

function DockTooltip({ target, dismiss }: { target: TooltipTarget; dismiss: () => void }) {
  const tip = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = tip.current;
    if (!element) return;
    const position = () => {
      const rect = target.button.getBoundingClientRect();
      const scroller = target.button.closest(".dock-apps")?.getBoundingClientRect();
      const left = Math.max(0, rect.left, scroller?.left ?? 0);
      const right = Math.min(innerWidth, rect.right, scroller?.right ?? innerWidth);
      if (!target.button.isConnected || left >= right || rect.bottom <= 0 || rect.top >= innerHeight) {
        element.style.visibility = "hidden";
        return;
      }
      const size = element.getBoundingClientRect();
      const x = Math.max(8, Math.min((left + right - size.width) / 2, innerWidth - size.width - 8));
      const y = Math.max(8, Math.min(rect.top - size.height - 16, innerHeight - size.height - 8));
      element.style.left = `${x}px`; element.style.top = `${y}px`; element.style.visibility = "visible";
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    const visibility = () => { if (document.hidden) dismiss(); };
    position();
    const observer = new ResizeObserver(position); observer.observe(target.button); observer.observe(element);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    window.addEventListener("keydown", key); window.addEventListener("pointerdown", dismiss, true); window.addEventListener("blur", dismiss);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true);
      window.removeEventListener("keydown", key); window.removeEventListener("pointerdown", dismiss, true); window.removeEventListener("blur", dismiss);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [target, dismiss]);
  // Keep the tooltip in Desktop's stacking context, outside the dock's scroll/blur clipping.
  return createPortal(<span ref={tip} className="dock-tooltip" id={target.id} role="tooltip">{target.label}{target.hint && <small>{target.hint}</small>}</span>, target.root);
}
