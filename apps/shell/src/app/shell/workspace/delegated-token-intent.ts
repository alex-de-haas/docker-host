// Shell's half of the delegated-token handshake that is not the protocol: the protocol itself
// (message types and the verified parser) ships in @hosty-sdk/app, so Shell consumes the published
// contract rather than keeping a private twin of it, exactly as it does for auth-required.
//
// What lives here is the policy the protocol deliberately does not encode — which app Shell hands a
// user-scoped credential to.

/** A token as Shell hands it to a frame: the credential plus when it stops being one. */
export type DelegatedTokenGrant = { token: string; expiresAt: string };

/**
 * Whether the app shown in the workspace may be answered with a delegated token. The assistant
 * gateway alone qualifies: Shell already mints these tokens for it to run the chat panel, so
 * answering its settings page gives that app nothing it did not already hold. Every other frame
 * gets no handler at all — the workspace surface is generic, and answering whatever the operator
 * installed would widen the delegated-token trust story by accident rather than by decision.
 *
 * The gateway is identified by the app that declares the `ai-gateway` interface rather than by a
 * hard-coded id, because the assistant is meant to be replaceable: a second implementation inherits
 * the grant, and a host with no gateway installed grants nothing.
 */
export function appMayReceiveDelegatedToken(
  appId: string | undefined,
  assistantGatewayAppId: string | undefined,
): boolean {
  return Boolean(appId) && appId === assistantGatewayAppId;
}
