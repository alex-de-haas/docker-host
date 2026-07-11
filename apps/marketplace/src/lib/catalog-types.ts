export const CATALOG_SCHEMA_VERSION = "marketplace.0.2";
export const FEEDS_SCHEMA_VERSION = "app-feeds.0.1";

// Fetched documents are untrusted. Optional fields describe their wire shape only; CatalogService
// performs all runtime normalization before data reaches a route or component.
export type CatalogIndex = {
  schemaVersion?: string | null;
  source?: CatalogSourceInfo | null;
  apps?: CatalogAppEntry[] | null;
};

export type CatalogSourceInfo = {
  name?: string | null;
  description?: string | null;
  url?: string | null;
};

export type CatalogAppEntry = {
  id?: string | null;
  name?: string | null;
  publisher?: CatalogPublisher | null;
  category?: string | null;
  tags?: string[] | null;
  display?: CatalogDisplay | null;
  feedsUrl?: string | null;
  signerIdentity?: string | null;
};

export type CatalogPublisher = {
  name?: string | null;
  url?: string | null;
  email?: string | null;
};

export type CatalogDisplay = {
  summary?: string | null;
  icon?: string | null;
  screenshots?: string[] | null;
  descriptionUrl?: string | null;
};

export type AppFeedsDocument = {
  schemaVersion?: string | null;
  appId?: string | null;
  feeds?: AppFeedEntry[] | null;
};

export type AppFeedEntry = {
  id?: string | null;
  manifestRef?: string | null;
  default?: boolean | null;
};

export type CatalogDiagnosticStatus = "ready" | "not-configured" | "unavailable" | "invalid";

export type CatalogDiagnostic = {
  status: CatalogDiagnosticStatus;
  code: string;
  message: string;
};

export type CatalogSourceSummary = {
  url: string | null;
  name: string;
  description: string | null;
};

export type CatalogAppsResponse = {
  apps: CatalogAppSummary[];
  source: CatalogSourceSummary;
  diagnostic: CatalogDiagnostic;
};

export type CatalogAppSummary = {
  id: string;
  name: string;
  summary: string | null;
  category: string | null;
  tags: string[];
  icon: string | null;
  publisher: CatalogPublisher | null;
  sourceName: string;
};

export type CatalogAppDetailResponse = {
  id: string;
  name: string;
  summary: string | null;
  category: string | null;
  tags: string[];
  icon: string | null;
  screenshots: string[];
  publisher: CatalogPublisher | null;
  sourceName: string;
  signerIdentity: string | null;
  feedsUrl: string | null;
  feeds: CatalogAppFeed[];
  feedDiagnostic: CatalogDiagnostic;
  descriptionUrl: string | null;
  description: string | null;
  descriptionDiagnostic: CatalogDiagnostic;
};

export type CatalogAppFeed = {
  id: string;
  manifestRef: string;
  default: boolean;
};

export type ErrorResponse = {
  code: string;
  message: string;
};

export type HealthResponse = {
  status: string;
};
