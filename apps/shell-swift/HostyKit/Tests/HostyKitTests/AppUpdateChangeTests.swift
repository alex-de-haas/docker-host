import Foundation
import Testing

@testable import HostyKit

/// Reading Core's change vocabulary.
///
/// These tokens are the whole content of a reviewed update: the operator is asked to approve a plan on
/// the strength of this list, so a change that is mis-parsed, or silently dropped, is a plan approved on
/// something other than what it says. The token shapes come from `BuildUpdatePlanChanges` in
/// `apps/core/src/Haas.Hosty.Core/CoreLifecycleService.cs`.
@Suite("Update plan changes")
struct AppUpdateChangeTests {
    private func parse(_ change: String) -> AppUpdateChange {
        AppUpdateChange(parsing: change)
    }

    @Test("A version move separates the subject from the two values")
    func version() {
        let change = parse("version:0.4.9->0.4.10")

        #expect(change.title == "Version")
        #expect(change.detail == "0.4.9 → 0.4.10")
        #expect(change.raw == "version:0.4.9->0.4.10")
    }

    // The one every routine update carries, and the reason this exists at all: two 64-character digests
    // run together with the service name are unreadable in a sheet.
    @Test("Artifact digests are shortened and split from the service that owns them")
    func artifactDigest() {
        let change = parse(
            "artifact:backend:sha256:f05e326e71aa7814ea34f68ed6282ac6932ee84cc23d058db05b1c00dcf59273"
                + "->sha256:1df50287b502fdabd7ec616b46ada2c9cd44698f699963e4d96d1c0c77afe8c0")

        #expect(change.title == "backend image digest")
        #expect(change.detail == "sha256:f05e326e71aa → sha256:1df50287b502")
    }

    // Core writes these when there is no prior lock and when the registry could not be reached. Neither
    // is a digest, and neither may be rendered as one.
    @Test("The digest endpoints Core uses for absence are passed through, not dressed up")
    func artifactDigestEndpoints() {
        #expect(parse("artifact:app:none->sha256:abc").detail == "none → sha256:abc")
        #expect(
            parse("artifact:app:sha256:f05e326e71aa7814ea34f68ed6282ac6932ee84cc23d058db05b1c00dcf59273->unknown")
                .detail == "sha256:f05e326e71aa → unknown")
    }

    @Test("A source app's moved branch tip reads as a commit")
    func sourceCommit() {
        let change = parse("source:0000000000000000000000000000000000000001->000000000000000000000000000000000000000a")

        #expect(change.title == "Source commit")
        #expect(change.detail == "00000000 → 00000000")
    }

    @Test("A bare token with nothing to compare carries no detail line")
    func valuelessChange() {
        let change = parse("manifest")

        #expect(change.title == "Manifest content changed")
        #expect(change.detail == nil)
    }

    @Test("Resources that appear or go away name the verb, and keep whatever value came with it")
    func addedAndRemoved() {
        #expect(parse("service:worker:added:docker").title == "Service worker added")
        #expect(parse("service:worker:added:docker").detail == "docker")
        #expect(parse("endpoint:api:removed:http/8080").title == "Endpoint api removed")
        #expect(parse("capability:mounts:added").title == "Capability mounts added")
        #expect(parse("capability:mounts:added").detail == nil)
        #expect(parse("container:web:preserved:hosty-web").title == "Container web preserved")
    }

    @Test("A named facet of a resource moving keeps the facet in the subject")
    func attributeChange() {
        let change = parse("setting:apiKey:type:string->secret")

        #expect(change.title == "Setting apiKey type")
        #expect(change.detail == "string → secret")

        #expect(parse("setting:apiKey:secret:False->True").title == "Setting apiKey secret flag")
        #expect(parse("service:worker:runtimeType:docker->localCommand").title == "Service worker runtime type")
        #expect(parse("service:worker:runtimeType:docker->localCommand").detail == "docker → localCommand")
    }

    // Core's value signatures are colon-delimited themselves (`EndpointSignature`,
    // `CoreLifecycleService.cs`), so their first field is a protocol, not a facet. Reading it as one put
    // the protocol in the title and split the value in the wrong place — mangling exactly the
    // review-class change the sheet exists to explain.
    @Test("A colon-delimited signature is a value, not a named facet")
    func endpointSignatureIsNotAFacet() {
        let change = parse("endpoint:api:http:public=False:service=web:port=8080->https:public=True:service=web:port=8443")

        #expect(change.title == "Endpoint api")
        #expect(change.detail == "http:public=False:service=web:port=8080 → https:public=True:service=web:port=8443")
    }

    @Test("A dependency signature is left whole too")
    func dependencySignature() {
        let change = parse("dependency:com.haas.db:com.haas.db:1.0:required=False:->com.haas.db:2.0:required=True:")

        #expect(change.title == "Dependency com.haas.db")
        #expect(change.detail == "com.haas.db:1.0:required=False: → com.haas.db:2.0:required=True:")
    }

    // A port signature is `{protocol}:{host}->{container}:public=…`, so a port transition carries three
    // arrows and the separator is the middle one. Splitting on the first put the container port and
    // every flag of the old signature on the "new" side of the arrow.
    @Test("A port transition splits on the separator, not on the arrow inside the signature")
    func portSignatureInnerArrow() {
        let change = parse(
            "port:backend.http:http:8080->3000:public=False:expose=loopback:transport=tcp"
                + "->http:9090->3000:public=True:expose=lan:transport=tcp")

        #expect(change.title == "Port backend.http")
        #expect(
            change.detail == "http:8080->3000:public=False:expose=loopback:transport=tcp"
                + " → http:9090->3000:public=True:expose=lan:transport=tcp")
    }

    // Both sides of a transition are the same grammar and so carry the same number of internal arrows,
    // which is what makes the middle occurrence the separator. An even count means that assumption does
    // not hold — a grammar this does not know — and the value is shown whole rather than split in the
    // wrong place.
    @Test("An unresolvable arrow count is shown whole rather than guessed at")
    func evenArrowCountIsNotSplit() {
        let change = parse("port:backend.http:a->b->c")

        #expect(change.title == "Port backend.http")
        #expect(change.detail == "a->b->c")
    }

    @Test("A simple resource value still splits on its only arrow")
    func resourceValueChange() {
        let change = parse("network:backend:bridge->host")

        #expect(change.title == "backend network")
        #expect(change.detail == "bridge → host")
    }

    @Test("An environment variable reports the change without ever reporting the value")
    func environmentChange() {
        #expect(parse("environment:backend.API_KEY:changed").title == "Environment variable backend.API_KEY changed")
        #expect(parse("environment:backend.API_KEY:changed").detail == nil)
    }

    // "compatible" means the existing data works with the target — the opposite of a change. Falling
    // through to the generic wording would tell the operator their data directory is being altered.
    @Test("A compatible data directory is not reported as a change to it")
    func compatibleData() {
        #expect(parse("data:compatible").title == "Data directory is kept as it is")
        #expect(parse("data:added:/var/lib/app").title == "Data directory added")
        #expect(parse("data:added:/var/lib/app").detail == "/var/lib/app")
        #expect(parse("data:target:/old->/new").detail == "/old → /new")
    }

    // Core's vocabulary grows. An unknown token has to survive to the screen exactly as written: this is
    // a review, and dropping a line means asking for approval of something the operator never saw.
    @Test("An unrecognized token is shown verbatim rather than dropped")
    func unknownToken() {
        let change = parse("somethingNewCoreInvented:tomorrow")

        #expect(change.title == "somethingNewCoreInvented:tomorrow")
        #expect(change.detail == nil)
        #expect(change.raw == "somethingNewCoreInvented:tomorrow")
    }

    @Test("Every change survives parsing, in order")
    func plansKeepEveryChange() throws {
        let json = Data(
            """
            {"appId":"com.haas.demo-app","currentVersion":"0.1.0","targetVersion":"0.2.0",
             "currentRuntime":"docker","targetRuntime":"docker","manifestPath":"/m.json",
             "manifestDigest":"abc","planDigest":"def","willCreatePreUpdateBackup":true,
             "changes":["version:0.1.0->0.2.0","manifest","service:worker:added:docker"],
             "sourceConfigured":true,"requiresReview":true}
            """.utf8)

        let plan = try JSONDecoder.core.decode(AppUpdatePlan.self, from: json)

        #expect(plan.readableChanges.count == plan.changes.count)
        #expect(plan.readableChanges.map(\.raw) == plan.changes)
        #expect(plan.readableChanges.first?.title == "Version")
    }
}
