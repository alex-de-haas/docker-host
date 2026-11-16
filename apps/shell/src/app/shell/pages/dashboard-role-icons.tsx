import { AudioLines, Bot, Brain, ClipboardCheck, Languages, PanelsTopLeft, type LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { CoreApp } from "../types";

type RoleIcon = { key: string; icon: LucideIcon; label: string; description: string };

const providerIcons: RoleIcon[] = [
  { key: "agent", icon: Brain, label: "Agent provider", description: "Runs agent sessions through a reviewed provider interface." },
  { key: "assistant", icon: Bot, label: "Assistant provider", description: "Provides assistant conversations through a reviewed provider interface." },
  { key: "speech-to-text", icon: AudioLines, label: "Speech-to-text provider", description: "Transcribes audio through a reviewed provider interface." },
  { key: "translation", icon: Languages, label: "Translation provider", description: "Translates text through a reviewed provider interface." },
];

/** Role marks describe reviewed supply, independently of the app's identity, branding or health. */
export function DashboardRoleIcons({ app, isShell }: { app: Pick<CoreApp, "confirmedRoles" | "interfaces">; isShell: boolean }) {
  // Review grants can outlive a removed interface. Describe only current declared supply;
  // its URL/readiness is deliberately irrelevant while the app is stopped or unavailable.
  const roles = new Set((app.confirmedRoles ?? []).filter(role => {
    const declarations = app.interfaces?.[role];
    return Array.isArray(declarations) && declarations.length > 0;
  }));
  const icons = providerIcons.filter(role => roles.has(role.key));
  const tasks = roles.has("tasks"), executor = roles.has("task-executor");
  if (tasks || executor) icons.push({
    key: "tasks", icon: ClipboardCheck,
    label: tasks && executor ? "Tasks and task executor" : tasks ? "Tasks provider" : "Task executor",
    description: tasks && executor
      ? "Provides task storage and executes task attempts through reviewed provider interfaces."
      : tasks ? "Stores and exposes tasks through a reviewed provider interface."
        : "Executes task attempts through a reviewed provider interface.",
  });
  // The selected Shell is an explicit host choice. An arbitrary UI or settings page does not
  // establish that an app is a Shell, and catalog names, tags and icons never establish a role.
  if (isShell) icons.push({ key: "shell", icon: PanelsTopLeft, label: "Shell interface",
    description: "Provides the selected Hosty web interface for navigation, app access, and host management." });
  if (!icons.length) return null;

  return <TooltipProvider delayDuration={150}>
    {icons.map(({ key, icon: Icon, label, description }) => <Tooltip key={key}>
      <TooltipTrigger asChild>
        <span tabIndex={0} role="img" aria-label={label} className="inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-sm text-muted-foreground outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-brand focus-visible:ring-0">
          <Icon aria-hidden="true" className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 space-y-1" sideOffset={4}>
        <p className="font-medium">{label}</p><p>{description}</p>
      </TooltipContent>
    </Tooltip>)}
  </TooltipProvider>;
}
