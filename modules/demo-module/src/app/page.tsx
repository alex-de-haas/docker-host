import { getDemoConfig, inspectStorage, moduleStartedAt } from "@/lib/demo-config";
import { getDemoPeople } from "@/lib/demo-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const config = getDemoConfig();
  const people = getDemoPeople();
  const storage = await inspectStorage();

  return (
    <main className="shell">
      <section className="topbar" aria-label="Module summary">
        <div>
          <p className="eyebrow">{config.moduleId}</p>
          <h1>Docker Host Demo Module</h1>
        </div>
        <div className="statusPill">
          <span aria-hidden="true" />
          Running
        </div>
      </section>

      <section className="hero">
        <div className="heroCopy">
          <p className="greeting">{config.greeting}</p>
          <h2>Module operations test surface</h2>
          <p>
            A compact module that exposes runtime config, storage probes, sample
            people data, and health endpoints for Docker Host development.
          </p>
        </div>
        <dl className="metricGrid">
          <div>
            <dt>Version</dt>
            <dd>{config.moduleVersion}</dd>
          </div>
          <div>
            <dt>Channel</dt>
            <dd>{config.releaseChannel}</dd>
          </div>
          <div>
            <dt>Refresh</dt>
            <dd>{config.refreshSeconds}s</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{new Date(moduleStartedAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}</dd>
          </div>
        </dl>
      </section>

      <section className="grid twoColumns" aria-label="Runtime details">
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
              <dt>Auth preview</dt>
              <dd>{config.authPreview ? "Enabled" : "Disabled"}</dd>
            </div>
            <div>
              <dt>Health endpoint</dt>
              <dd>/api/health</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <div className="panelHeader">
            <h2>People</h2>
            <a href="/api/people">JSON</a>
          </div>
          <div className="peopleList">
            {people.map(person => (
              <div className="personRow" key={person.id}>
                <div>
                  <strong>{person.name}</strong>
                  <span>{person.role}</span>
                </div>
                <span className={`state state-${person.status}`}>{person.status}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="panel" aria-label="Storage">
        <div className="panelHeader">
          <h2>Storage probes</h2>
          <a href="/api/health">Health</a>
        </div>
        <div className="storageGrid">
          {storage.map(item => (
            <article className="storageItem" key={item.key}>
              <div>
                <h3>{item.label}</h3>
                <p>{item.path}</p>
              </div>
              <span className={item.exists ? "state state-active" : "state state-disabled"}>
                {item.exists ? "mounted" : "missing"}
              </span>
              {item.entries.length > 0 ? (
                <ul>
                  {item.entries.map(entry => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              ) : (
                <p className="emptyText">{item.error || "No visible entries."}</p>
              )}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
