import Foundation
import Testing

@testable import HostyKit

@Suite("Platform version")
struct PlatformVersionTests {
    @Test("Ordinary versions parse and order")
    func parsesAndOrders() throws {
        #expect(PlatformVersion("0.70.0") == PlatformVersion(0, 70, 0))
        #expect(try #require(PlatformVersion("0.69.1")) < #require(PlatformVersion("0.70.0")))
        #expect(try #require(PlatformVersion("0.70.0")) < #require(PlatformVersion("0.70.1")))
        #expect(try #require(PlatformVersion("0.9.0")) < #require(PlatformVersion("0.10.0")))
        #expect(try #require(PlatformVersion("1.0.0")) > #require(PlatformVersion("0.999.999")))
    }

    @Test("A pre-release or build suffix is ignored, not rejected")
    func suffixes() {
        #expect(PlatformVersion("0.70.0-rc.1") == PlatformVersion(0, 70, 0))
        #expect(PlatformVersion("0.70.0+abc123") == PlatformVersion(0, 70, 0))
    }

    @Test("A shortened version fills the missing components with zero")
    func shortened() {
        #expect(PlatformVersion("0.70") == PlatformVersion(0, 70, 0))
        #expect(PlatformVersion("1") == PlatformVersion(1, 0, 0))
    }

    @Test("Nonsense does not parse")
    func rejectsNonsense() {
        #expect(PlatformVersion("") == nil)
        #expect(PlatformVersion("latest") == nil)
        #expect(PlatformVersion("0.x.0") == nil)
        #expect(PlatformVersion("0.70.0.1") == nil)
        #expect(PlatformVersion("-1.0.0") == nil)
    }

    // The reason this type exists. The client speaks only bearer, which Core learned in 0.70.0; against an
    // older host a sign-in harvests a cookie, then every request 401s and the app bounces back to the
    // sign-in screen with nothing to explain why.
    @Test("A host older than the bearer release is reported as unsupported")
    func minimumSupported() throws {
        func status(_ version: String) throws -> CoreStatus {
            let json = Data(#"{"status":"running","component":"hosty-core","version":"\#(version)"}"#.utf8)
            return try JSONDecoder.core.decode(CoreStatus.self, from: json)
        }

        #expect(try !status("0.69.1").isSupportedVersion)
        #expect(try !status("0.12.0").isSupportedVersion)
        #expect(try status("0.70.0").isSupportedVersion)
        #expect(try status("0.71.3").isSupportedVersion)
        #expect(try status("1.0.0").isSupportedVersion)
    }

    // Refusing to talk to a host because its version string is unfamiliar would be the worse failure: a
    // scheme this client cannot read is far more likely to be newer than older.
    @Test("An unreadable version is treated as supported")
    func unparseableVersionIsAllowed() throws {
        let json = Data(#"{"status":"running","component":"hosty-core","version":"nightly"}"#.utf8)
        let status = try JSONDecoder.core.decode(CoreStatus.self, from: json)

        #expect(status.platformVersion == nil)
        #expect(status.isSupportedVersion)
    }
}
