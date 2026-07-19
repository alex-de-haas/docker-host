// The auth-required intent contract now ships in @hosty-sdk/app: Shell was the reference
// implementation the SDK's embedder slice was extracted from, and consuming it back makes the
// reference and the shipped artifact the same code. This module keeps the historical import
// path for the workspace panel and its tests.
export { AUTH_REQUIRED_INTENT_TYPE } from "@hosty-sdk/app";
export {
  parseActiveFrameAuthRequired,
  type AuthRequiredMessage,
} from "@hosty-sdk/app/embedder";
