![Hosty Telemetry](../assets/icon.svg)

# Hosty Telemetry

Observability for everything running on a Hosty host: metrics, structured logs,
and traces, collected and kept locally. Nothing leaves the machine.

## What it gives you

- **Metrics** — container and host signals per app, with a meter tree so you pick
  exactly what is collected rather than swallowing everything.
- **Structured logs** — the fleet-wide OTLP log stream, filterable by app and
  severity, distinct from an app's raw console output.
- **Traces** — request timelines across apps, for when a slow page is really a
  slow dependency.

## How it fits together

Three services ship as one app: an **OpenTelemetry collector** that receives OTLP
from every instrumented app, a **backend** that stores signals in an embedded
SQLite database with retention limits, and a **UI** that reads that backend
directly and renders the pages above.

Runtime apps discover the collector automatically. The app declares the
`otlp-collector` platform capability, so Core provisions its config, starts it
before the apps that export to it, and injects the endpoint into them — whether
this app was installed from the marketplace, seeded on a fresh host, or installed
by hand.

## Good to know

Telemetry is optional and off by default. Installing it starts collection; removing
it stops collection and nothing else — the apps that were exporting keep running,
and their exports simply go nowhere until a collector exists again. Only host
administrators can open it.
