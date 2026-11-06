import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function WorkspaceSectionHeading({ children, information, informationLabel, actions }: {
  actions?: ReactNode; children: ReactNode; information: ReactNode; informationLabel: string;
}) {
  return <div className="flex items-center justify-between gap-2">
    <h3 className="text-xs font-semibold text-muted-foreground">{children}</h3>
    <div className="flex shrink-0 items-center gap-1">{actions}
    <TooltipProvider delayDuration={250}><Tooltip>
      <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="size-6 text-muted-foreground" aria-label={informationLabel}><Info className="size-3.5" aria-hidden /></Button></TooltipTrigger>
      <TooltipContent className="max-w-xs">{information}</TooltipContent>
    </Tooltip></TooltipProvider></div>
  </div>;
}
