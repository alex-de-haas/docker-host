"use client";
import { Suspense, useContext, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { HostyOverlay } from "./overlay-react";
import { UiCompositionContext } from "./ui-context";
import type { UiRouterAdapter } from "./ui-types";

/** Next routing stays an optional adapter; the composition model does not patch browser history. */
export function HostyNextNavigationBridge() {
  const model = useContext(UiCompositionContext), router = useRouter(), pathname = usePathname(), search = useSearchParams();
  const current = useRef(router); current.current = router;
  const listeners = useRef(new Set<() => void>());
  const adapter = useMemo<UiRouterAdapter>(() => ({
    getRoute: () => `${window.location.pathname}${window.location.search}${window.location.hash}`,
    subscribe(listener) { listeners.current.add(listener); window.addEventListener("hashchange", listener);
      return () => { listeners.current.delete(listener); window.removeEventListener("hashchange", listener); }; },
    navigate(route) { current.current.push(route); },
  }), []);
  useEffect(() => { model?.attachRouter(adapter); return () => model?.attachRouter(); }, [model, adapter]);
  useEffect(() => { for (const listener of listeners.current) listener(); }, [pathname, search]);
  return null;
}
export function HostyNextOverlay({ children, ...props }: Parameters<typeof HostyOverlay>[0]) {
  return <HostyOverlay {...props}><Suspense fallback={null}><HostyNextNavigationBridge /></Suspense>{children}</HostyOverlay>;
}
