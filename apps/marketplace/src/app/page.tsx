// Placeholder root page. The storefront moves here from Shell in Phase 2
// (docs/ideas/marketplace-system-app.md); until then the app serves only the /v1/catalog API.
export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Hosty Marketplace</h1>
      <p>Read-only catalog service. The storefront UI arrives with Phase 2; see /healthz and /v1/catalog.</p>
    </main>
  );
}
