"use client";
import { MessageSquarePlus } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useShellActions } from "../shell-context";

export function AppSessionMenuItem({ appId }: { appId: string }) {
  const { newAppAssistantSession, assistantSessionPending } = useShellActions();
  if (!newAppAssistantSession) return null;
  return <DropdownMenuItem disabled={assistantSessionPending} onClick={() => void newAppAssistantSession(appId)}>
    <MessageSquarePlus className="h-4 w-4" />New assistant session
  </DropdownMenuItem>;
}
