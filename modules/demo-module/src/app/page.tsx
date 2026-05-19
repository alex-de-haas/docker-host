import { headers } from "next/headers";
import { getDemoConfig, inspectStorage, moduleStartedAt } from "@/lib/demo-config";
import { getDemoPeople } from "@/lib/demo-data";
import { getDemoAuthSnapshot } from "@/lib/host-auth";
import type { ModuleDirectoryStatus, ModuleIdentityStatus } from "@/lib/host-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const config = getDemoConfig();
  const people = getDemoPeople();
  const storage = await inspectStorage();
  const auth = await getDemoAuthSnapshot(await headers());

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
          <div>
            <dt>Identity</dt>
            <dd>{formatIdentityStatus(auth.identity.status)}</dd>
          </div>
          <div>
            <dt>Directory</dt>
            <dd>{formatDirectoryStatus(auth.directory.status)}</dd>
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
              <dt>Identity audience</dt>
              <dd>{config.host.moduleId}</dd>
            </div>
            <div>
              <dt>Host internal origin</dt>
              <dd>{config.host.internalOrigin}</dd>
            </div>
            <div>
              <dt>Service token</dt>
              <dd>{config.host.moduleServiceTokenConfigured ? "Configured" : "Missing"}</dd>
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

      <section className="grid twoColumns" aria-label="Host authorization">
        <article className="panel">
          <div className="panelHeader">
            <h2>Host identity</h2>
            <a href="/api/auth/identity">JSON</a>
          </div>
          <div className="authStack">
            <div className="authStatusRow">
              <span className={identityStateClass(auth.identity.status)}>
                {formatIdentityStatus(auth.identity.status)}
              </span>
              <span className="smallText">{auth.identity.headerName}</span>
            </div>
            {auth.identity.claims ? (
              <dl className="detailList compactList">
                <div>
                  <dt>Subject</dt>
                  <dd>{auth.identity.claims.subject}</dd>
                </div>
                <div>
                  <dt>User</dt>
                  <dd>{auth.identity.claims.name || auth.identity.claims.email || "Unnamed Host user"}</dd>
                </div>
                <div>
                  <dt>Host role</dt>
                  <dd>{auth.identity.claims.hostRole || "Unknown"}</dd>
                </div>
                <div>
                  <dt>Module access</dt>
                  <dd>{auth.identity.claims.moduleAccess || "Unknown"}</dd>
                </div>
                <div>
                  <dt>Exposure policy</dt>
                  <dd>{auth.identity.claims.moduleExposurePolicy || "Unknown"}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{auth.identity.claims.expiresAt || "Unknown"}</dd>
                </div>
              </dl>
            ) : (
              <p className="emptyText">{auth.identity.error || "No Host identity token was received."}</p>
            )}
          </div>
        </article>

        <article className="panel">
          <div className="panelHeader">
            <h2>Module directory</h2>
            <span className={directoryStateClass(auth.directory.status)}>
              {formatDirectoryStatus(auth.directory.status)}
            </span>
          </div>
          <div className="authStack">
            <dl className="detailList compactList">
              <div>
                <dt>Endpoint</dt>
                <dd>{auth.directory.endpoint || "Unavailable"}</dd>
              </div>
              <div>
                <dt>Assigned users</dt>
                <dd>{auth.directory.pagination?.total ?? auth.directory.users.length}</dd>
              </div>
            </dl>
            {auth.directory.users.length > 0 ? (
              <div className="peopleList">
                {auth.directory.users.map(user => (
                  <div className="personRow" key={user.id}>
                    <div>
                      <strong>{user.displayName || user.email || user.id}</strong>
                      <span>{user.email || user.id}</span>
                    </div>
                    <span className="state state-active">{user.hostRole}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="emptyText">
                {auth.directory.error?.message || "No assigned Host users were returned."}
              </p>
            )}
          </div>
        </article>
      </section>

      <section className="grid twoColumns" aria-label="Module-owned authorization">
        <article className="panel">
          <div className="panelHeader">
            <h2>Module permissions</h2>
            <span className="state state-active">{auth.modulePermissions.role}</span>
          </div>
          <dl className="detailList compactList">
            <div>
              <dt>Principal</dt>
              <dd>{auth.modulePermissions.principal}</dd>
            </div>
            <div>
              <dt>Permissions</dt>
              <dd>{auth.modulePermissions.permissions.join(", ")}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <div className="panelHeader">
            <h2>Gateway request</h2>
            <span className={auth.gateway.hostSessionCookieForwarded ? "state state-disabled" : "state state-active"}>
              Host cookie {auth.gateway.hostSessionCookieForwarded ? "present" : "stripped"}
            </span>
          </div>
          <dl className="detailList compactList">
            <div>
              <dt>Host</dt>
              <dd>{auth.gateway.host || "Unknown"}</dd>
            </div>
            <div>
              <dt>Forwarded host</dt>
              <dd>{auth.gateway.forwardedHost || "Missing"}</dd>
            </div>
            <div>
              <dt>Forwarded proto</dt>
              <dd>{auth.gateway.forwardedProto || "Missing"}</dd>
            </div>
            <div>
              <dt>X-Docker-Host headers</dt>
              <dd>{auth.gateway.dockerHostHeaders.length > 0 ? auth.gateway.dockerHostHeaders.join(", ") : "None"}</dd>
            </div>
          </dl>
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

function formatIdentityStatus(status: ModuleIdentityStatus) {
  switch (status) {
    case "verified":
      return "Verified";
    case "invalid":
      return "Invalid";
    case "not-configured":
      return "Not configured";
    case "not-present":
      return "Not present";
  }
}

function formatDirectoryStatus(status: ModuleDirectoryStatus) {
  switch (status) {
    case "ok":
      return "Ready";
    case "forbidden":
      return "Forbidden";
    case "unavailable":
      return "Unavailable";
    case "error":
      return "Error";
    case "not-configured":
      return "Not configured";
  }
}

function identityStateClass(status: ModuleIdentityStatus) {
  if (status === "verified") {
    return "state state-active";
  }

  return status === "not-present" ? "state state-invited" : "state state-disabled";
}

function directoryStateClass(status: ModuleDirectoryStatus) {
  if (status === "ok") {
    return "state state-active";
  }

  return status === "not-configured" ? "state state-invited" : "state state-disabled";
}
