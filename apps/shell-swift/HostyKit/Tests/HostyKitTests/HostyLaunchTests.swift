import Foundation
import Testing

@testable import HostyKit

/// Declaring the launch mode on a workspace URL. The app reads this to drop the name and page
/// navigation this client already renders, so a URL that loses the parameter shows two of each, and a
/// URL that loses anything else opens the wrong page.
@Suite("Declaring the native launch mode")
struct HostyLaunchTests {
    @Test("The mode is declared on a URL that carries no query")
    func declaresOnBareUrl() {
        let url = URL(string: HostyLaunch.declaringNativeMode("http://192.168.1.10:49152/metrics"))

        #expect(url?.path == "/metrics")
        #expect(url?.query == "hosty_launch=native")
    }

    @Test("Existing query items and the fragment survive")
    func preservesTheRest() {
        let declared = HostyLaunch.declaringNativeMode("http://192.168.1.10:49152/logs?tail=1&level=warn#tail")
        let components = URLComponents(string: declared)

        #expect(components?.fragment == "tail")
        #expect(components?.queryItems?.first { $0.name == "tail" }?.value == "1")
        #expect(components?.queryItems?.first { $0.name == "level" }?.value == "warn")
        #expect(components?.queryItems?.first { $0.name == "hosty_launch" }?.value == "native")
    }

    // A page switch re-declares the mode against a URL this client may have already declared it on.
    @Test("Re-declaring replaces rather than duplicating")
    func isIdempotent() {
        let once = HostyLaunch.declaringNativeMode("http://192.168.1.10:49152/")
        let twice = HostyLaunch.declaringNativeMode(once)

        #expect(twice == once)
        #expect(URLComponents(string: twice)?.queryItems?.filter { $0.name == "hosty_launch" }.count == 1)
    }

    @Test("A mode the URL already carries is replaced, never appended to")
    func replacesAForeignValue() {
        let declared = HostyLaunch.declaringNativeMode("http://192.168.1.10:49152/?hosty_launch=embedded")
        let items = URLComponents(string: declared)?.queryItems?.filter { $0.name == "hosty_launch" }

        #expect(items?.count == 1)
        #expect(items?.first?.value == "native")
    }

    // `URLComponents` refuses almost nothing: it reads `not a url` as a relative path and hands back
    // `not%20a%20url`, so a parse that merely succeeded would let this rewrite an address Core never
    // advertised — and the operator's failure would then name the invented URL.
    @Test("Anything that is not an absolute URL comes back unchanged")
    func leavesNonAbsoluteInputAlone() {
        #expect(HostyLaunch.declaringNativeMode("not a url") == "not a url")
        #expect(HostyLaunch.declaringNativeMode("/metrics") == "/metrics")
        #expect(HostyLaunch.declaringNativeMode("") == "")
    }
}
