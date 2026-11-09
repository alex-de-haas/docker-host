---
created: 2026-11-03
updated: 2026-11-07
summary: Exact-run operator recovery for interrupted Harness execution.
components: [apps/harness]
---

# Interrupted Harness Session Recovery

## Stop And Recovery

Harness retains the run and source activity claim when native process exit cannot be confirmed.
Stop retries cleanup through a retained Worker handle, including after a failed stop left the
receipt interrupted. Successful cleanup releases provider capacity and the conversation's source
claim through the normal completion path. It does not replay the prompt or commands.

After a Local Worker restart, older receipts do not identify surviving native processes reliably.
The owning operator signs in through Core, opens the affected conversation, retries Stop and checks
that the old agent and all commands it started have stopped. The interrupted-execution panel then
requires an explicit checkbox before **Recover stopped execution**. Recovery records that operator
attestation; it does not terminate processes, infer exit from a missing handle, delete the transcript
or reset source files. A Worker that still owns the execution refuses attestation and requires Stop.
This is cooperative recovery, not a per-session containment boundary.

The recovery review binds the request to the conversation, run, Worker generation and receipt
revision. The server requires the owning interactive app session and same-origin mutation checks;
delegated agent credentials cannot invoke this operation. Active, changed and foreign executions
are rejected. The authenticated Worker API atomically stores the confirmation, operator, timestamp,
terminal receipt and request UUID. Replaying that UUID is idempotent; changed arguments conflict.

The coordinator persists the request before sending it. **Retry recovery** reuses the same request
after a lost reply, browser reload or coordinator restart. It retries normal source cleanup with
fresh Hosty authority after Worker acknowledgement. Pending cleanup prevents new prompt admission.
Only a completed cleanup closes the recovery request. Files and history remain available for a
later explicit continuation; recovery itself sends no new prompt.

Recovery review waits for serialized conversation setup and the new Worker's durable acceptance
before reading its receipt. A freshly submitted prompt therefore does not display a missing-run
error while its journal record is still being created. The wait covers acceptance only, not the
agent's response or coordinator event callbacks. A retained run whose acceptance receipt is missing receives a separate recovery review bound to
the current Worker generation. The owning interactive operator must still explicitly confirm native
exit. Recovery atomically writes a cancelled tombstone for that exact conversation/run before
normal source cleanup; a late submission cannot execute the recovered identity. Ordinary admission
failures remain visible and are never inferred to be successful runs.

## Verified Local Runtime

On 2026-11-05, Harness 0.94.0 was verified on macOS in a parent-managed child Core 0.175.2
with disposable identity/data. Normal Core browser password login and app launch succeeded.
A synthetic legacy Local receipt, prepared only while the isolated services were stopped without
launching a provider, became interrupted after startup. Stop retained the unconfirmed execution;
explicit UI recovery cancelled it, cleared the working indicator and retained the original request.
The native execution observation confirmed stop. The same recovery request remained idempotent
after a real API/Worker restart. Source content remained unchanged.

The full Harness suite passed 2,601 tests in 227 files. Backend/web lint and type checks and the
production web build passed. `npm run test:integration -- worker` passed the manifest-matching
Docker Worker lifecycle/native-contract checks without provider credentials or model inference.
`HOSTY_EXECUTION_RECOVERY=1 npm run test:integration -- harness-local` passed cold/warm startup,
normal authentication, recovery/replay, missing-output rebuild and restart durability. Parent Finish
confirmed child resource removal; the fixture credentials, data, processes and temporary source
were removed. Core/CLI builds retained the existing Microsoft.DotNet.ILCompiler NU1903 warning.
Windows runtime and live provider inference were not exercised for this recovery change.

The older workspace's feedback-continuation alternative is not part of this recovery change.
Current feedback continuation follows the separately maintained explicit-resend workflow in
[feedback processing](../app-feedback-inbox/feature.md).

## Applied Ordinary-Data Recovery

On 2026-11-05, the operator approved applying the verified 0.94.0 workspace to the installed
Harness through Core's managed development controls, including the required skill-library access
review. Core retained the previous Local runtime and created its pre-development data backup.
The selected workspace became active with healthy API and Worker services. During this trial,
the installed package remained unchanged and the registered development workspace supplied the
recovery implementation.

After checking that no native process used the affected repository and that the old Harness
services had stopped, the operator recovered the retained MCP-context conversation through the
interactive confirmation flow. Its native execution became cancelled with current confirmed stop;
the workspace participant became idle and the old source activity lease was released. Retrying the
original pending pause completed it without creating a replacement operation. Resume restored the
workspace to in-progress state and made its message composer available. Browser reload retained
this result without sending a new prompt.

All 17 changed files in the MCP workspace and all 35 changed files in the original recovery
workspace matched their saved hashes after recovery. All 14 original conversation message payloads
remained unchanged. Both original workspaces remain available; recovery performed no source reset.

## Testing Expectations

Worker coverage includes failed native Stop followed by successful retry, refusal while a handle
is retained, legacy Local journal restart, missing confirmation, stale generation/revision and
same-request replay across restart, bounded transient sharing failures and durable usage clocks.
Missing-receipt recovery covers current-generation review, explicit exit confirmation, active-run
refusal, late-admission conflicts and replay after a real service restart.
Coordinator tests cover owner checks, unchanged history, source
claim release, lost replies and failed Core cleanup without new prompt admission. HTTP tests require
interactive authentication, ownership and same-origin requests. UI tests require explicit confirmation,
retain the same request after uncertainty and restore server-retained requests.
Regression coverage delays both conversation preparation and Worker acceptance, checks admission
failure without blocking the conversation queue, and preserves missing-receipt errors after restart.

Runtime verification
uses a Core-managed Local sandbox, normal password login and launch-code identity, with synthetic
interrupted records prepared only while that test app is stopped. Real provider inference and detached
process discovery are outside that fixture; operator recovery relies on explicit exit attestation.
