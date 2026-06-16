"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useShellActions } from "../shell-context";
import type {
  NotificationMarkReadResponse,
  NotificationsResponse,
  ShellNotification,
} from "../types";

const LIST_LIMIT = 20;
const POLL_INTERVAL_MS = 30_000;

export function NotificationBell({ compact }: { compact: boolean }) {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const [items, setItems] = useState<ShellNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${coreOrigin}/api/notifications?limit=${LIST_LIMIT}`, {
        credentials: "include",
      });
      // A background poll must not hijack navigation; the main shell refresh owns auth redirects.
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as NotificationsResponse;
      if (!mounted.current) {
        return;
      }

      setItems(data.notifications);
      setUnread(data.unreadCount);
    } catch {
      // Transient network error; the next poll or SSE event recovers.
    }
  }, [coreOrigin]);

  // Initial load + polling fallback.
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  // Live updates over SSE (best-effort; polling covers any gap).
  useEffect(() => {
    let source: EventSource | null = null;
    try {
      source = new EventSource(`${coreOrigin}/api/notifications/stream`, { withCredentials: true });
      source.onmessage = (event) => {
        if (!mounted.current) {
          return;
        }

        try {
          const view = JSON.parse(event.data) as ShellNotification;
          setItems((current) => [view, ...current.filter((n) => n.id !== view.id)].slice(0, LIST_LIMIT));
          setUnread((current) => (view.read ? current : current + 1));
        } catch {
          // Ignore malformed events.
        }
      };
    } catch {
      // EventSource unavailable; polling is the fallback.
    }

    return () => source?.close();
  }, [coreOrigin]);

  // Refresh when the panel is opened.
  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  const markAllRead = useCallback(async () => {
    setBusy(true);
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/notifications/read`, { ids: null });
      const data = (await response.json()) as NotificationMarkReadResponse;
      if (!mounted.current) {
        return;
      }

      setUnread(data.unreadCount);
      setItems((current) => current.map((n) => (n.read ? n : { ...n, read: true })));
    } catch {
      // sendCsrfJson surfaces auth/Core errors; leave state to the next load.
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  }, [coreOrigin, sendCsrfJson]);

  const activate = useCallback(
    async (notification: ShellNotification) => {
      if (!notification.read) {
        setItems((current) => current.map((n) => (n.id === notification.id ? { ...n, read: true } : n)));
        setUnread((current) => Math.max(0, current - 1));
        try {
          const response = await sendCsrfJson(`${coreOrigin}/api/notifications/read`, { ids: [notification.id] });
          const data = (await response.json()) as NotificationMarkReadResponse;
          if (mounted.current) {
            setUnread(data.unreadCount);
          }
        } catch {
          // Optimistic update stands; the next load reconciles.
        }
      }

      if (notification.link) {
        window.open(notification.link, "_blank", "noopener,noreferrer");
        setOpen(false);
      }
    },
    [coreOrigin, sendCsrfJson],
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={compact ? "ghost" : "outline"}
          size={compact ? "icon-lg" : "default"}
          className={cn("relative", compact ? "mx-auto flex size-11" : "w-full justify-start")}
          title="Notifications"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="h-4 w-4" />
          {!compact && <span>Notifications</span>}
          {unread > 0 && (
            <span
              className={cn(
                "absolute flex min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold leading-4 text-white",
                compact ? "right-1 top-1" : "right-2 top-1/2 -translate-y-1/2",
              )}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={compact ? "right" : "top"}
        align={compact ? "end" : "start"}
        sideOffset={8}
        className="w-80 p-0"
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Notifications</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={busy || unread === 0}
            onClick={() => void markAllRead()}
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">No notifications</div>
          ) : (
            items.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onActivate={() => void activate(notification)}
              />
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NotificationRow({
  notification,
  onActivate,
}: {
  notification: ShellNotification;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className={cn(
        "flex w-full gap-2 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent",
        !notification.read && "bg-accent/40",
      )}
    >
      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", levelDotClass(notification.level))} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-sm", !notification.read && "font-medium")}>{notification.title}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(notification.createdAt)}</span>
        </span>
        {notification.body && (
          <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{notification.body}</span>
        )}
      </span>
    </button>
  );
}

function levelDotClass(level: string): string {
  switch (level) {
    case "success":
      return "bg-emerald-500";
    case "warning":
      return "bg-amber-500";
    case "error":
      return "bg-rose-500";
    default:
      return "bg-sky-500";
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) {
    return "now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }

  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w`;
  }

  return new Date(iso).toLocaleDateString();
}
