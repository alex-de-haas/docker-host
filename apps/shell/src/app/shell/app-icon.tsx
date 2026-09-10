"use client";

import { useCallback, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { DynamicIcon, iconNames } from "lucide-react/dynamic";
import { cn } from "@/lib/utils";

import { createAppIconNameResolver } from "./app-icon-name";

const resolveIconName = createAppIconNameResolver(iconNames);

type AppIconProps = {
  src: string | null;
  name?: string | null;
  fallback: LucideIcon;
  className?: string;
  alt?: string;
};

// Image failures belong to one URL; a new asset/version must get a fresh load attempt.
export function AppIcon(props: AppIconProps) {
  return <AppIconContent key={props.src ?? ""} {...props} />;
}

function AppIconContent({ src, name, fallback: Fallback, className, alt = "" }: AppIconProps) {
  const [failed, setFailed] = useState(false);
  const renderFallback = useCallback(() => <Fallback className="size-full" />, [Fallback]);
  const namedIcon = resolveIconName(name);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={alt}
        className={cn("shrink-0 object-contain", className)}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  if (namedIcon) {
    return (
      <span className={cn("inline-flex shrink-0 [&>svg]:size-full", className)} role={alt ? "img" : undefined} aria-label={alt || undefined} aria-hidden={!alt}>
        <DynamicIcon key={namedIcon} name={namedIcon} fallback={renderFallback} className="size-full" />
      </span>
    );
  }

  return <Fallback className={cn("shrink-0", className)} aria-hidden={!alt} aria-label={alt || undefined} />;
}
