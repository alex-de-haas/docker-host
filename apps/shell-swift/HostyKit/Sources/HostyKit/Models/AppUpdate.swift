import Foundation

/// The cached availability verdict on an app summary. Null until a check has run for that app.
public struct AppUpdateAvailability: Hashable, Sendable, Codable {
    public let updateAvailable: Bool
    public let requiresReview: Bool
    public let planDigest: String?
    public let checkedAt: Date
    public let error: String?
}

/// Fleet update-check state, from the `updateCheck` block on `GET /api/apps`.
public struct AppUpdateCheckStatus: Hashable, Sendable, Codable {
    public let running: Bool
    public let lastCompletedAt: Date?
}

/// `POST /api/apps/update-check`. `started` is false when the call joined a sweep already in flight.
public struct AppUpdateCheckTrigger: Sendable, Codable {
    public let started: Bool
    public let status: AppUpdateCheckStatus
}

/// `GET /api/apps/{id}/update-status`.
public struct AppUpdateStatus: Sendable, Codable {
    public let appId: String
    public let runtime: String
    public let runtimeType: String
    public let updatePolicy: String
    public let updateAvailable: Bool
    public let services: [AppServiceUpdateStatus]
    public let manifestUpdateAvailable: Bool?
    public let manifestUnknown: Bool?
}

public struct AppServiceUpdateStatus: Hashable, Sendable, Codable {
    public let service: String
    public let lockedDigest: String?
    public let candidateDigest: String?
    public let updateAvailable: Bool
    /// The registry could not be reached, or there is no lock to compare a candidate against.
    public let unknown: Bool
}

/// A reviewed update plan, from `POST /api/apps/{id}/update/plan`.
///
/// `planDigest` is what makes the apply a *reviewed* one: `POST /api/apps/{id}/update` requires the digest
/// of the plan that was shown, so an apply can never silently act on a plan that changed after review.
public struct AppUpdatePlan: Hashable, Sendable, Codable {
    public let appId: String
    public let currentVersion: String
    public let targetVersion: String
    public let currentRuntime: String?
    public let targetRuntime: String
    public let manifestPath: String
    public let manifestDigest: String
    public let planDigest: String
    public let willCreatePreUpdateBackup: Bool
    public let changes: [String]

    /// False when no external source is configured and the recheck could only read Core's internal copy —
    /// so an empty `changes` does **not** mean the app is up to date.
    public let sourceConfigured: Bool?

    /// True when the change list carries anything beyond routine version/manifest movement. Such a plan
    /// must be shown to a person rather than applied silently.
    public let requiresReview: Bool?

    public var mustBeReviewed: Bool { requiresReview ?? false }
}

/// `GET /api/apps/{id}/update/plan`. A null plan means nothing is pending: never built, expired, or
/// already consumed by an apply.
public struct AppPendingUpdatePlan: Sendable, Codable {
    public let plan: AppUpdatePlan?
}
