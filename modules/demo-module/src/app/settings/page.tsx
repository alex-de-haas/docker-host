import { getDemoConfig, inspectStorage } from "@/lib/demo-config";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const config = getDemoConfig();
  const storage = await inspectStorage();

  return (
    <main className="shell">
      <section className="topbar" aria-label="Settings summary">
        <div>
          <p className="eyebrow">{config.moduleId}</p>
          <h1>Settings</h1>
        </div>
        <div className="statusPill">
          <span aria-hidden="true" />
          {config.releaseChannel}
        </div>
      </section>

      <section className="grid twoColumns" aria-label="Module settings">
        <article className="panel">
          <div className="panelHeader">
            <h2>Runtime config</h2>
            <a href="/api/config">JSON</a>
          </div>
          <dl className="detailList">
            <div>
              <dt>Public URL</dt>
              <dd>{config.publicUrl}</dd>
            </div>
            <div>
              <dt>Greeting</dt>
              <dd>{config.greeting}</dd>
            </div>
            <div>
              <dt>Refresh</dt>
              <dd>{config.refreshSeconds}s</dd>
            </div>
            <div>
              <dt>Auth preview</dt>
              <dd>{config.authPreview ? "Enabled" : "Disabled"}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <div className="panelHeader">
            <h2>Host integration</h2>
            <span className={config.host.moduleServiceTokenConfigured ? "state state-active" : "state state-disabled"}>
              Service token {config.host.moduleServiceTokenConfigured ? "configured" : "missing"}
            </span>
          </div>
          <dl className="detailList">
            <div>
              <dt>Internal origin</dt>
              <dd>{config.host.internalOrigin}</dd>
            </div>
            <div>
              <dt>Identity audience</dt>
              <dd>{config.host.moduleId}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="storageGrid" aria-label="Storage settings">
        {storage.map(item => (
          <article className="storageItem" key={item.key}>
            <div>
              <h2>{item.label}</h2>
              <p>{item.path}</p>
            </div>
            <span className={item.exists ? "state state-active" : "state state-disabled"}>
              {item.exists ? "Available" : "Missing"}
            </span>
            {item.entries.length > 0 ? (
              <ul>
                {item.entries.map(entry => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            ) : (
              <p>{item.error || "No visible entries."}</p>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
