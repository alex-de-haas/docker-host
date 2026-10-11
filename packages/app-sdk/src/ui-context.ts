"use client";
import { createContext } from "react";
import type { UiHost } from "./ui-host";
export const UiHostContext = createContext<UiHost | null>(null);
