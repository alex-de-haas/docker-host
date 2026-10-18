# Resource SSE verification — 2026-10-16

Recovered on 2026-10-18 from the original checkout at `f146d0ddd810eeaaa1d9cc922bf6c000a6d1d3e2`
plus its then-uncommitted SSE implementation. This is a historical report, not a new run against
current main. The runtime feature and newer merged fixes remain authoritative for present behavior.

## SSE verification on 2026-10-16

The migration uses platform 0.133.0 and Shell 0.102.0. A separate Core data root and Core-managed
production Shell were exercised on macOS through normal administrator setup and email/password
login. Two uninterrupted Chromium measurements recorded one initial resource-history GET, zero
subsequent resource GETs and continuous samples (149 seconds / 42 samples and 125 seconds / 34
samples). After a real Core outage, the same page recovered through the BFF with one HTTP resync,
a new run identity and advancing resource values. Resource reads did not recur during the outage;
stream reconnection backed off through proxy 503 responses. The Core-managed Shell process stayed
running throughout recovery. Controlled visibility changes in the live page removed the resource
topic while leaving the generic stream open, stopped resource reads/frames, and restored delivery
with one history GET on return.

`dotnet build apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj` and the Core test suite used
`--artifacts-path build/resource-sse`: build passed with four existing warnings; 3157 tests passed
and four existing opt-in Docker/VPN/Telemetry integrations were skipped. `npm run shell:lint`
passed with two existing warnings, `npm run shell:test` passed 192 Node tests and 283 component
tests, and `npm run shell:build` passed. Version consistency and documentation-index checks pass.
The new transport tests cover stalled HTTP timeouts and proxy errors leaving EventSource closed,
in addition to the lifecycle, buffering, sequence and upgrade scenarios above.

Safari 27.0.1 WebDriver could not create a session because Allow Remote Automation is disabled.
Native tab visibility/freeze scheduling was not reproduced by this Chromium automation session.
Visibility/page restoration are covered by controlled lifecycle events and deterministic tests.
Safari suspension/restoration and native OS sleep are unverified; browser-specific scheduling is
not inferred from those tests. Acquisition implementations and Telemetry
transport are unchanged, so their separate native-platform/live ingestion checks were not repeated.

