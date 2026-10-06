import Foundation
import Testing

@testable import HostyKit

@Suite("Native app-owned sign-in handoff")
struct NativeAppSignInTests {
    private let state = String(repeating: "a", count: 64)
    private let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    private var core: HostOrigin { try! HostOrigin(parsing: "https://core.example.test") }
    private var app: HostOrigin { try! HostOrigin(parsing: "https://app.example.test:8443") }
    private var callback: String { "https://app.example.test:8443/people?hosty_launch=native&state=" + state }

    private func broker(redirect: String? = nil, publicState: String? = nil,
        proof: String? = nil, method: String = "S256") -> URL {
        core.url(path: "/api/apps/com.test.app/open", queryItems: [
            URLQueryItem(name: "redirectUri", value: redirect ?? callback),
            URLQueryItem(name: "state", value: publicState ?? state),
            URLQueryItem(name: "codeChallenge", value: proof ?? challenge),
            URLQueryItem(name: "codeChallengeMethod", value: method),
        ])
    }

    private func parse(_ url: URL, source: HostOrigin? = nil,
        sourceMain: Bool = true, targetMain: Bool = true, approved: [String]? = nil) -> NativeAppSignIn? {
        NativeAppSignIn.parse(url, appID: "com.test.app", coreOrigin: core, sourceOrigin: source ?? app,
            approvedAppURLs: approved ?? ["https://app.example.test:8443/people"],
            sourceIsMainFrame: sourceMain, targetIsMainFrame: targetMain)
    }

    @Test("The approved main-frame app passes only its public challenge and correlated callback")
    func validHandoff() throws {
        let request = try #require(parse(broker()))
        #expect(request.state == state)
        #expect(request.redirectURI == callback)
        #expect(request.codeChallenge == challenge)
        #expect(request.codeChallengeMethod == "S256")
    }

    @Test("In-place renewal allows only the exact web-message selector")
    func inPlaceRenewal() throws {
        var parts = try #require(URLComponents(url: broker(), resolvingAgainstBaseURL: false))
        parts.queryItems?.append(URLQueryItem(name: "responseMode", value: "web_message"))
        #expect(parse(try #require(parts.url))?.inPlace == true)
        #expect(parse(broker())?.inPlace == false)
        parts.queryItems?.append(URLQueryItem(name: "responseMode", value: "web_message"))
        #expect(parse(try #require(parts.url)) == nil)
        parts.queryItems?.removeAll { $0.name == "responseMode" }
        parts.queryItems?.append(URLQueryItem(name: "responseMode", value: "redirect"))
        #expect(parse(try #require(parts.url)) == nil)
        #expect(parse(try #require(parts.url), sourceMain: false) == nil)
    }

    @Test("Origin and app path identity includes scheme, host and port", arguments: [
        "http://core.example.test/api/apps/com.test.app/open",
        "https://core.example.test:8443/api/apps/com.test.app/open",
        "https://foreign.example.test/api/apps/com.test.app/open",
        "https://core.example.test/api/apps/com.other.app/open",
        "https://core.example.test/login",
        "https://user:password@core.example.test/api/apps/com.test.app/open",
    ])
    func wrongBroker(address: String) throws {
        let url = try #require(URL(string: address))
        #expect(!NativeAppSignIn.isBrokerNavigation(url, appID: "com.test.app", coreOrigin: core))
        #expect(parse(url) == nil)
    }

    @Test("Only the approved app origin can use native session authority", arguments: [
        "https://foreign.example.test:8443", "https://app.example.test", "http://app.example.test:8443",
        "https://core.example.test",
    ])
    func wrongSource(address: String) throws {
        #expect(parse(broker(), source: try HostOrigin(parsing: address)) == nil)
    }

    @Test("Source and target must both be the main frame")
    func mainFrames() {
        #expect(parse(broker(), sourceMain: false) == nil)
        #expect(parse(broker(), targetMain: false) == nil)
        #expect(parse(broker(), sourceMain: false, targetMain: false) == nil)
    }

    private static var refusedCallbacks: [String] {
        let publicState = String(repeating: "a", count: 64)
        return [
        "https://foreign.example.test:8443/people?state=" + publicState,
        "https://app.example.test/people?state=" + publicState,
        "http://app.example.test:8443/people?state=" + publicState,
        "https://user:password@app.example.test:8443/people?state=" + publicState,
        "https://app.example.test:8443/people",
        "https://app.example.test:8443/people?state=wrong",
        "https://app.example.test:8443/people?state=" + publicState + "&state=" + publicState,
        "https://app.example.test:8443/people?state=" + publicState + "&code=old",
        "https://app.example.test:8443/people?state=" + publicState + "&codeVerifier=secret",
        "https://app.example.test:8443/people?state=" + publicState + "#fragment",
        "app.example.test:8443/people?state=" + publicState,
    ]
    }

    @Test("Callback origin, public state and credential-free shape are checked",
        arguments: NativeAppSignInTests.refusedCallbacks)
    func wrongCallback(address: String) {
        #expect(parse(broker(redirect: address)) == nil)
    }

    @Test("The callback state must equal the public broker state")
    func mismatchedPublicState() {
        #expect(parse(broker(publicState: String(repeating: "b", count: 64))) == nil)
        #expect(parse(broker(publicState: "short")) == nil)
        #expect(parse(broker(publicState: String(repeating: "A", count: 64))) == nil)
    }

    @Test("Missing, duplicate, extra and fragmented broker fields are refused")
    func malformedFields() throws {
        for transform in [
            { (items: [URLQueryItem]) in Array(items.dropLast()) },
            { (items: [URLQueryItem]) in items + [items[0]] },
            { (items: [URLQueryItem]) in items + [URLQueryItem(name: "codeVerifier", value: "secret")] },
            { (items: [URLQueryItem]) in items + [URLQueryItem(name: "prompt", value: "none")] },
        ] {
            var parts = try #require(URLComponents(url: broker(), resolvingAgainstBaseURL: false))
            parts.queryItems = transform(try #require(parts.queryItems))
            #expect(parse(try #require(parts.url)) == nil)
        }
        var parts = try #require(URLComponents(url: broker(), resolvingAgainstBaseURL: false))
        parts.fragment = "ignored"
        #expect(parse(try #require(parts.url)) == nil)
    }

    @Test("Only canonical SHA256 challenges and S256 pass")
    func proofSyntax() {
        #expect(parse(broker(proof: "short")) == nil)
        #expect(parse(broker(proof: String(repeating: "A", count: 42) + "B")) == nil)
        #expect(parse(broker(proof: challenge + "=")) == nil)
        #expect(parse(broker(method: "plain")) == nil)
        #expect(NativeAppSignIn.isCanonicalChallenge(challenge))
    }

    @Test("A malformed manifest URL is not an approved source")
    func malformedApproval() {
        #expect(parse(broker(), approved: ["app.example.test:8443/people"]) == nil)
        #expect(parse(broker(), approved: ["https://user:password@app.example.test:8443/people"]) == nil)
    }

    @Test("The callback response can append only its own unexpired code")
    func launchCallback() throws {
        let request = try #require(parse(broker()))
        let now = Date(timeIntervalSince1970: 1_000)
        let valid = AppLaunchCode(code: "issued", redirectUri: callback + "&code=issued", expiresAt: now.addingTimeInterval(300))
        #expect(request.accepts(valid, now: now))
        #expect(!request.accepts(AppLaunchCode(code: "", redirectUri: valid.redirectUri, expiresAt: valid.expiresAt), now: now))
        #expect(!request.accepts(AppLaunchCode(code: "other", redirectUri: valid.redirectUri, expiresAt: valid.expiresAt), now: now))
        #expect(!request.accepts(AppLaunchCode(code: valid.code, redirectUri: valid.redirectUri, expiresAt: now), now: now))
        for redirect in [
            valid.redirectUri + "&code=issued", valid.redirectUri + "&extra=surprise",
            valid.redirectUri.replacingOccurrences(of: "app.example", with: "foreign.example"),
            valid.redirectUri.replacingOccurrences(of: state, with: String(repeating: "b", count: 64)),
            valid.redirectUri + "#fragment",
        ] {
            #expect(!request.accepts(AppLaunchCode(code: valid.code, redirectUri: redirect, expiresAt: valid.expiresAt), now: now))
        }
    }

    @Test("Duplicate attempts never remint and fresh attempts obey the throttle")
    func replayAndThrottle() throws {
        let first = try #require(parse(broker()))
        let secondState = String(repeating: "b", count: 64)
        let second = try #require(parse(broker(redirect: callback.replacingOccurrences(of: state, with: secondState),
            publicState: secondState)))
        var gate = NativeSignInGate()
        let now = Date(timeIntervalSince1970: 1_000)
        let accepted1 = gate.claim(first, now: now)
        #expect(accepted1)
        let accepted2 = gate.claim(first, now: now.addingTimeInterval(4))
        #expect(!accepted2)
        let accepted3 = gate.claim(second, now: now.addingTimeInterval(2))
        #expect(!accepted3)
        gate.finish(first)
        let accepted4 = gate.claim(first, now: now.addingTimeInterval(4))
        #expect(!accepted4)
        let accepted5 = gate.claim(second, now: now.addingTimeInterval(4))
        #expect(accepted5)
        gate.finish(first)
        #expect(gate.isCurrent(second))
        #expect(!gate.isCurrent(first))
        gate.finish(second)
        #expect(gate.pendingState == nil)
        // A discarded coordinator on logout/eviction carries none of its predecessor's state.
        #expect(NativeSignInGate().pendingState == nil)
    }

    @Test("Allowed main-frame navigation invalidates asynchronous delivery")
    func replacedDocument() throws {
        let request = try #require(parse(broker()))
        var gate = NativeSignInGate()
        let claimed = gate.claim(request)
        #expect(claimed)
        let generation = gate.documentGeneration
        #expect(gate.isCurrent(request, generation: generation))
        gate.documentChanged()
        #expect(!gate.isCurrent(request, generation: generation))
        #expect(gate.pendingState == nil)
        #expect(gate.documentGeneration != generation)
        gate.finish(request)
        #expect(gate.pendingState == nil)
    }

    @Test("A primary confirmation must be authenticated, enabled and the same native account")
    func renewalAccount() {
        let member = HostUser(id: "native_user", email: "native@example.test", displayName: "Native",
            role: "host.member", disabled: false)
        let other = HostUser(id: "other", email: "other@example.test", displayName: "Other",
            role: "host.admin", disabled: false)
        let disabled = HostUser(id: member.id, email: member.email, displayName: member.displayName,
            role: member.role, disabled: true)
        #expect(NativeAppSignIn.acceptsRenewalSession(AuthSession(authenticated: true, user: member), expectedUserID: member.id))
        #expect(!NativeAppSignIn.acceptsRenewalSession(AuthSession(authenticated: true, user: other), expectedUserID: member.id))
        #expect(!NativeAppSignIn.acceptsRenewalSession(AuthSession(authenticated: true, user: disabled), expectedUserID: member.id))
        #expect(!NativeAppSignIn.acceptsRenewalSession(AuthSession(authenticated: false, user: member), expectedUserID: member.id))
        #expect(!NativeAppSignIn.acceptsRenewalSession(AuthSession(authenticated: true, user: nil), expectedUserID: member.id))
        #expect(!NativeAppSignIn.acceptsRenewalSession(AuthSession(authenticated: true, user: member), expectedUserID: nil))
        #expect(!NativeAppSignIn.acceptsRenewalSession(AuthSession(authenticated: true, user: member), expectedUserID: ""))
    }

    @Test("Recent claimed state is bounded and expiry permits a new attempt")
    func boundedAttempts() {
        var gate = NativeSignInGate()
        let now = Date(timeIntervalSince1970: 1_000)
        for index in 0..<16 {
            let request = NativeAppSignIn(redirectURI: callback, state: String(index),
                codeChallenge: challenge, codeChallengeMethod: "S256")
            let accepted6 = gate.claim(request, now: now.addingTimeInterval(Double(index * 3)))
            #expect(accepted6)
            gate.finish(request)
        }
        let seventeenth = NativeAppSignIn(redirectURI: callback, state: "new", codeChallenge: challenge, codeChallengeMethod: "S256")
        let accepted7 = gate.claim(seventeenth, now: now.addingTimeInterval(60))
        #expect(!accepted7)
        let accepted8 = gate.claim(seventeenth, now: now.addingTimeInterval(301))
        #expect(accepted8)
    }
}
