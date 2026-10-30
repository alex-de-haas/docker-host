---
status: Draft
created: 2026-10-26
updated: 2026-10-29
summary: Persistent addressed decision requests, authorized resolution and durable continuation handoff beyond an individual live session.
components: [apps/core, apps/harness, packages/app-sdk, packages/app-sdk-dotnet]
---

# Shared Decisions And Human Response

## Goal And Baseline

Let a person review questions from many sessions in one place and answer after the original process
has stopped. Harness currently has question/permission waits and background notifications; these do
not provide a shared durable decision record with guaranteed continuation after a long wait.

The preferred candidate is a Core-owned shared record with application-owned presentation and routing.
This Draft follows [vision decisions 55-56](../../vision.md) and authorizes no implementation.

## Deferred After Basic Tasks (2026-10-27)

The owner defers shared addressed decisions and durable waiting beyond the Ready
[Basic Tasks](../basic-tasks/feature.md) feature. Simple task review stays in that task lifecycle;
this plan's D1-D4 and the runner's parked-continuation work remain unimplemented and Draft.

## Target Behavior

A request identifies its requester, authorized respondent, question/options or response schema,
related task/session, reviewed material revisions, state and attributed resolution. Resolve current
rights when presenting or answering; permission to see a task does not automatically grant access
to a private conversation or authority to answer its question.

An existing human user selected by the task owner/coordinator can be a default recipient.
Attribute the request to the invoking app and authorizing user/grant, with an optional opaque
executor-option reference for display; no Core agent principal or shared profile is required.
Task links are qualified by their task provider. The task-provider decision does not settle this
plan's separate record/storage choice.

Team/role routing and escalation stay in the coordinator. The actual respondent and routing changes remain visible. Clients can aggregate pending
requests; notifications point to the record and dismissing a notification does not answer it.

Persist the request/wait relationship before presenting a question. A saved response and its pending
continuation event must survive restart. The owning runner consumes that response, reconciles its
wait and reports the continuation outcome. The Decisions service does not run an agent or assume
that a delivered event proves it resumed.

Resource-wait time and decision expiry are different. Silence grants no consent. Define withdrawn,
expired, stale and superseded requests, competing answers and late answers after cancellation.
Changed reviewed inputs can invalidate an acceptance; a prior answer cannot silently approve a new
revision. Keep question resolution distinct from whether subsequent work succeeded.

## Basic Task Review Boundary

[Basic Tasks](../basic-tasks/feature.md) supports requiresReview with Blocked/needs_review and an
explicit accept/request-changes action under its own lifecycle. That basic review does not require
this shared inbox, question record or overnight continuation service. Native live question controls
also retain their current behavior. This plan's D1-D4 own the richer addressed, durable cross-session
decision feature and remain unfinished; simple task review does not complete them.

## Dependencies And Ownership

[Durable Agent Jobs](../durable-agent-jobs/plan.md) owns live-versus-parked waiting, resource release,
restart reconciliation and actual continuation; its D7 owns recoverable session context and
provider/account-bound cursors. [Agent Providers](../agent-provider-interface/plan.md)
owns native execution capabilities. No hidden model state is promised portable.

[Notifications D6](../notifications/plan.md#deliverables) owns durable event transport; existing
notifications and channels own delivery. [Harness Work Orchestration](../harness-work-orchestration/plan.md)
owns the first unified inbox and reviewer routing, including its authenticated answer UI.
Existing Core users and app identities supply attribution; [Basic Tasks](../basic-tasks/feature.md)
owns task/executor references and [Artifacts](../shared-artifacts/plan.md) owns accessible materials.
Harness profiles are internal execution choices, not separately authorized decision principals.

Questions, business acceptance and permission requests may share a UI while retaining their own
enforcement. [Approval Rules](../assistant-approval-rules/plan.md) and execution authorization own
tool permissions; do not replay an expired native permission or convert plan acceptance into
publication/deployment authority.

## Assistant Event Correlation (2026-10-29)

[Assistant Events And Session Continuation](../assistant-events-and-continuation/plan.md) supplies the
recipient-binding, event receipt and admission seam for a resolved decision. D2-D4 here retain the
record, authorized answer and consistent response publication; Notifications D6 retains transport,
and Durable Agent Jobs retains waiting/recovery. Register the wait before exposing the question,
preserve its identity through replay and distinguish an answered decision from an accepted or
completed continuation. An unrelated application event cannot satisfy a permission wait. This
coordination adds no implicit consent, new permission replay or implementation approval.

## PR Merge Decision Example (2026-10-29)

An event-triggered routine may ask, "Merge this reviewed dependency update?" Keep the repository/PR,
reviewed head and relevant evidence/policy revision with the decision. The user can answer from the
shared Decisions view without finding the originating chat. A persisted yes resumes the waiting
routine; it does not prove a merge occurred. A no prevents that proposed merge. Changed inputs make
the old decision stale under D2, and the action owner rechecks current rights, CI/reviews and branch
protection immediately before a revision-bound merge request.

[Durable Agent Jobs](../durable-agent-jobs/plan.md#event-triggered-routine-example-2026-10-29) owns
routine execution; [Assistant Events](../assistant-events-and-continuation/plan.md#design-consumer-repository-events-and-dependabot-routines)
owns event admission/correlation. The separate [PR inbox plan](../harness-pull-request-inbox/feature.md)
can link the decision, while this plan remains the owner of its record. The inbox is independently
usable without this decision service; a PR is one possible reviewed subject, not a required field
of every question or answer. A configured automatic action
can omit a human question within valid prior authority; no fabricated human answer or reusable
approval for a different PR/head is recorded. This is an example of D1-D4, not a new implementation.

## Deliverables

- [ ] D1. Define record ownership, request/response schema, respondent and material-revision semantics, states, retention and compatibility with existing question/approval cards.
- [ ] D2. Specify authorized create/read/resolve operations and atomic response-to-continuation publication with the event and runner owners, including duplicate answers, expiry, staleness and cancellation.
- [ ] D3. After explicit Ready approval, implement the selected persistent record/API/SDK and question adapter with addressed queries, notifications and durable continuation correlation, preserving permission enforcement boundaries.
- [ ] D4. Verify live and overnight answers through the runner contract, response/parking races, restart, missing executors, unauthorized respondents and late answers; document record and continuation outcomes in feature.md.

## Proposed Sequence

Resolve D1-D2 with the task/artifact references and runner wait protocol. Implement the shared record
before relying on the aggregated inbox; integration must prove an answered request can continue after
restart. Rich routing and escalation can follow the single-owner case.

## Open Questions

- Which question types share a response schema, and how are native permissions represented honestly?
- How are a respondent's departure, reassignment and changed rights handled?
- What retention protects pending decisions and their review materials without retaining live compute?
- Which changed inputs invalidate which types of decision, and who may reopen or supersede them?

## Verification

For this Draft, validate documents and links. Future checks include a quick answer, overnight wait,
answer during parking, restart before/after response persistence, repeated delivery and executor
unavailability. Confirm only one continuation, no automatic consent, no private-content disclosure
and no revival of cancelled work. The full user journey belongs to Harness integration.
