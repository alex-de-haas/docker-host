"use client";
import { createContext } from "react";
import type { UiHost } from "./ui-host";
export const UiHostContext = createContext<UiHost | null>(null);

import type { UiCompositionModel } from "./ui-composition";
export const UiCompositionContext = createContext<UiCompositionModel | null>(null);
