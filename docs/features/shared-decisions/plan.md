---
status: Draft
created: 2026-10-26
updated: 2026-10-26
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

## Target Behavior

A request identifies its requester, authorized respondent, question/options or response schema,
related task/session, reviewed material revisions, state and attributed resolution. Resolve current
rights when presenting or answering; permission to see a task does not automatically grant access
to a private conversation or authority to answer its question.

The responsible human can be a default recipient. Team/role routing and escalation stay in the
coordinator. The actual respondent and routing changes remain visible. Clients can aggregate pending
requests; notifications point to the record and dismissing a notification does not answer it.

Persist the request/wait relationship before presenting a question. A saved response and its pending
continuation event must survive restart. The owning runner consumes that response, reconciles its
wait and reports the continuation outcome. The Decisions service does not run an agent or assume
that a delivered event proves it resumed.

Resource-wait time and decision expiry are different. Silence grants no consent. Define withdrawn,
expired, stale and superseded requests, competing answers and late answers after cancellation.
Changed reviewed inputs can invalidate an acceptance; a prior answer cannot silently approve a new
revision. Keep question resolution distinct from whether subsequent work succeeded.

## Dependencies And Ownership

[Durable Agent Jobs](../durable-agent-jobs/plan.md) owns live-versus-parked waiting, resource release,
restart reconciliation and actual continuation. [Shared History](../assistant-shared-history/plan.md)
owns recoverable session context and provider cursors. [Agent Providers](../agent-provider-interface/plan.md)
owns native execution capabilities. No hidden model state is promised portable.

[Notifications D6](../notifications/plan.md#deliverables) owns durable event transport; existing
notifications and channels own delivery. [Harness Work Orchestration](../harness-work-orchestration/plan.md)
owns the first unified inbox and reviewer routing, including its authenticated answer UI.
[Agent Participants](../agent-participants/plan.md) and [Artifacts](../shared-artifacts/plan.md) own
identity and accessible review materials.

Questions, business acceptance and permission requests may share a UI while retaining their own
enforcement. [Approval Rules](../assistant-approval-rules/plan.md) and execution authorization own
tool permissions; do not replay an expired native permission or convert plan acceptance into
publication/deployment authority.

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
