import { getDemoPeople } from "@/lib/demo-data";
import { getDemoConfig } from "@/lib/demo-config";

export const dynamic = "force-dynamic";

export default function PeoplePage() {
  const config = getDemoConfig();
  const people = getDemoPeople();

  return (
    <main className="shell">
      <section className="topbar" aria-label="People summary">
        <div>
          <p className="eyebrow">{config.moduleId}</p>
          <h1>People</h1>
        </div>
        <div className="statusPill">
          <span aria-hidden="true" />
          {people.length} records
        </div>
      </section>

      <section className="panel" aria-label="People directory">
        <div className="panelHeader">
          <h2>Directory sample</h2>
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
      </section>
    </main>
  );
}
