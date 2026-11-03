"use client";
import { createContext, type RefObject } from "react";
export const StandaloneNavigationContext = createContext<{
  collapsed: boolean; narrow: boolean; open: boolean; setOpen: (open: boolean) => void;
  opener: RefObject<HTMLButtonElement | null>;
} | null>(null);
