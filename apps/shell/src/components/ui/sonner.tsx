"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-center"
      offset={56}
      mobileOffset={16}
      closeButton
      visibleToasts={3}
      icons={{
        success: <CircleCheckIcon className="size-4 text-success-foreground" />,
        info: <InfoIcon className="size-4 text-info-foreground" />,
        warning: <TriangleAlertIcon className="size-4 text-warning-foreground" />,
        error: <OctagonXIcon className="size-4 text-destructive-foreground" />,
        loading: <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--width": "min(420px, calc(100vw - 2rem))",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
