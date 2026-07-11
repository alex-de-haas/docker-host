// Coded error surfaced by the API with the same wire shape Core uses ({ code, message }), so the
// Core compatibility proxy can pass responses through unchanged.
export class MarketplaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}
