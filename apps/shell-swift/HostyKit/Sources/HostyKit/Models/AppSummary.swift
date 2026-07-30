import Foundation

/// One installed app, as `GET /api/apps` reports it.
///
/// A hand-written mirror of Core's `AppSummary` (apps/core/src/Haas.Hosty.Core/AppRegistryStore.cs).
/// Only the fields this client renders are declared; Codable ignores the rest, so Core can keep adding
/// them. Fields Core declares nullable are optional here — and because synthesized Codable also treats an
/// optional as "may be absent", they tolerate an older or newer Core omitting the key entirely.
public struct AppSummary: Identifiable, Hashable, Sendable, Codable {
    public let id: String
    public let displayName: String
    public let description: String?
    public let version: String
    public let kind: String
    public let system: Bool
    public let source: String
    public let selectedRuntime: String?
    public let autostart: Bool
    public let operationStatus: String
    public let runtimeState: AppRuntimeState
    public let lastOperation: String?
    public let lastError: String?
    public let capabilities: [String]
    public let endpoints: [AppEndpoint]
    public let runtimeProfiles: [AppRuntimeProfile]
    public let updatePolicy: String

    /// The running/locked artifact per service. Present for compiled runtimes; absent for a live source
    /// app, which has no fixed artifact to lock.
    public let artifactLocks: [String: ArtifactLock]?

    /// Set when the live source manifest was invalid at the last start and Core fell back to the last-good
    /// copy. Non-blocking: the app is running, but from a contract the operator did not intend.
    public let manifestError: String?

    /// True when the selected runtime re-reads the operator's own folder on every start. Such an app has no
    /// reviewed-update path at all, so the update affordance is hidden rather than disabled.
    public let live: Bool

    public let iconUrl: String?
    public let updateCheck: AppUpdateAvailability?
    public let dependencies: [AppDependency]?

    /// Where this app's own UI lives, resolved by Core from the manifest `ui` block against the named
    /// endpoint — the operator's configured public origin when there is one, the local URL otherwise.
    ///
    /// Absent for a headless app, and that absence is the whole test for "can this be opened": public
    /// endpoints alone do not make a UI. Core computes it, so a client must never assemble its own —
    /// the redirect allowlist only accepts an origin the app itself declares.
    public let embeddedUrl: String?

    /// The manifest's declared pages. Empty or absent means the app has exactly one page, its entry.
    public let navigation: [AppNavigationItem]?

    /// True when Core reports a UI to open. A stopped app still qualifies — being openable and being
    /// ready are different questions, and the second is `runtimeState`.
    public var hasUI: Bool {
        !(embeddedUrl ?? "").isEmpty
    }

    /// The pages to offer, entry first. A one-page app yields just its entry, so a caller never has to
    /// special-case the empty navigation list.
    public var pages: [AppNavigationItem] {
        guard let navigation, !navigation.isEmpty else {
            guard let embeddedUrl, !embeddedUrl.isEmpty else { return [] }
            return [AppNavigationItem(label: displayName, path: "/", embeddedUrl: embeddedUrl, iconUrl: iconUrl)]
        }

        return navigation.filter { !($0.embeddedUrl ?? "").isEmpty }
    }

    /// True while a long-running operation owns the record.
    ///
    /// `operationStatus` records the **outcome of the last operation** — `started`, `restarted`,
    /// `installed`, `updated`, `stopped`, `failed`, `configured`, `runtime-switched` — and exactly one of
    /// its values means work is in flight: `updating`, which an asynchronous apply writes while it runs.
    /// There is no `idle` in that vocabulary, so reading "anything but idle" as busy marks every app on
    /// the host as working, permanently.
    public var isOperating: Bool {
        operationStatus == AppOperationStatus.updating
    }

    /// Problems worth a marker in the list, in the order a person would want to see them.
    public var problems: [String] {
        var problems: [String] = []
        if let lastError, !lastError.isEmpty {
            problems.append(lastError)
        }

        if let manifestError, !manifestError.isEmpty {
            problems.append(manifestError)
        }

        for dependency in dependencies ?? [] where dependency.required && !dependency.satisfied {
            problems.append(dependency.problemDescription)
        }

        return problems
    }
}

/// The `operationStatus` vocabulary Core writes. Only `updating` describes work still in progress.
public enum AppOperationStatus {
    public static let updating = "updating"
    public static let failed = "failed"
}

/// Core's `AppRuntimeStates` vocabulary.
///
/// The three predicates are carried over deliberately. Core's own comment warns that `!isUp` is not
/// `isIdle`: a control gated on "nothing is happening" that is written as the negation of "running"
/// silently widens to include an app mid-transition. Asking the right question is the whole reason this
/// is an enum with named predicates rather than a string comparison at each call site.
public enum AppRuntimeState: String, Hashable, Sendable, Codable {
    case running
    case starting
    case stopping
    case stopped
    case unknown

    /// May traffic reach it? Only a fully started app qualifies.
    public var isUp: Bool { self == .running }

    /// Is a lifecycle verb in flight, so the app must not be disturbed?
    public var isBusy: Bool { self == .starting || self == .stopping }

    /// Is it safe to do something destructive? Deliberately the narrowest predicate: stopped only.
    public var isIdle: Bool { self == .stopped }

    // A state this client has never heard of is reported as unknown rather than failing the whole list
    // decode. Core may add to the vocabulary; one new state must not blank the screen.
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AppRuntimeState(rawValue: raw) ?? .unknown
    }
}

/// One page of an app's UI, as the manifest declared it and Core resolved it.
///
/// `embeddedUrl` is optional in the contract and a page without one cannot be opened, which is why
/// `AppSummary.pages` filters those out rather than handing a caller a page it cannot load.
public struct AppNavigationItem: Hashable, Sendable, Codable, Identifiable {
    public let label: String
    public let path: String
    public let embeddedUrl: String?
    public let iconUrl: String?

    /// Stable within one app: the manifest cannot declare the same path twice.
    public var id: String { path }

    public init(label: String, path: String, embeddedUrl: String?, iconUrl: String?) {
        self.label = label
        self.path = path
        self.embeddedUrl = embeddedUrl
        self.iconUrl = iconUrl
    }
}

/// A one-time authorization code and the URL that carries it, from `POST /api/apps/{id}/launch-code`.
///
/// Single-use and short-lived: opening the same app again mints a new one rather than reloading a URL
/// whose code has already been spent, which would land on a signed-out app.
public struct AppLaunchCode: Hashable, Sendable, Codable {
    public let code: String
    public let redirectUri: String
    public let expiresAt: Date
}

public struct AppEndpoint: Hashable, Sendable, Codable {
    public let key: String
    public let `protocol`: String
    public let url: String?
    public let `public`: Bool
    public let service: String?
    public let port: String?
    public let publicOrigin: String?
    public let availability: AppEndpointAvailability?
}

public enum AppEndpointAvailability: String, Hashable, Sendable, Codable {
    /// A durable target exists but the owning service is stopped.
    case assigned
    /// The service is up.
    case running
    /// The persisted target failed to resolve.
    case unavailable

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AppEndpointAvailability(rawValue: raw) ?? .unavailable
    }
}

/// The resolved, immutable identity of a compiled artifact, advanced only by a reviewed update.
public struct ArtifactLock: Hashable, Sendable, Codable {
    public let kind: String
    public let imageDigest: String?
    public let resolvedFromRef: String?
    public let commit: String?
    public let resolvedAt: Date?

    /// Short form for a badge: `sha256:abcdef…` is unreadable, the first few hex digits are not.
    public var shortDigest: String? {
        guard let imageDigest else { return nil }

        let hex = imageDigest.split(separator: ":").last.map(String.init) ?? imageDigest
        return String(hex.prefix(12))
    }
}

public struct AppRuntimeProfile: Hashable, Sendable, Codable {
    public let key: String
    public let type: String
    public let `default`: Bool
    public let development: Bool?
    public let developmentMode: Bool?
}

public struct AppDependency: Hashable, Sendable, Codable {
    public let appId: String
    public let version: String?
    public let required: Bool
    public let installed: Bool
    public let running: Bool

    public var satisfied: Bool { installed && running }

    var problemDescription: String {
        installed ? "Dependency \(appId) is not running." : "Dependency \(appId) is not installed."
    }
}

/// `GET /api/apps`. `updateCheck` is absent on surfaces that do not attach it.
public struct AppsResponse: Sendable, Codable {
    public let apps: [AppSummary]
    public let updateCheck: AppUpdateCheckStatus?
}
