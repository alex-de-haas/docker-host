import Foundation

/// One line of an update plan's change list, read out of Core's own vocabulary.
///
/// Core reports changes as machine tokens — `artifact:backend:sha256:f05e…->sha256:1df5…`,
/// `setting:apiKey:type:string->secret` — which are precise and unreadable. This splits each into the
/// thing that changed and the values it moved between, so a screen can render the first as prose and
/// the second apart from it: a wall of undifferentiated identifiers is not review, whatever it contains.
///
/// The vocabulary mirrors `formatUpdateChange` in the browser Shell (`apps/shell/src/app/shell/
/// app-helpers.ts`). Two clients reading the same tokens must not invent two names for them.
public struct AppUpdateChange: Hashable, Sendable, Identifiable {
    /// What changed, as a phrase: `Version`, `backend image digest`, `Setting apiKey added`.
    public let title: String

    /// The values, when there are any worth reading: `0.4.9 → 0.4.10`. Kept apart from the title because
    /// these are identifiers, not prose, and want a monospaced line of their own.
    public let detail: String?

    /// Core's original token. The identity, and the fallback for anything this does not recognize — an
    /// unknown change must still be shown, exactly as Core wrote it, rather than dropped or guessed at.
    public let raw: String

    public var id: String { raw }

    public init(title: String, detail: String? = nil, raw: String) {
        self.title = title
        self.detail = detail
        self.raw = raw
    }
}

extension AppUpdatePlan {
    /// The change list, parsed. Order is preserved: Core reports the significant movement first.
    public var readableChanges: [AppUpdateChange] {
        changes.map(AppUpdateChange.init(parsing:))
    }
}

extension AppUpdateChange {
    public init(parsing change: String) {
        let (kind, rest) = AppUpdateChange.split(change, at: ":")

        switch kind {
        case "manifest":
            self.init(title: "Manifest content changed", raw: change)

        case "version":
            self.init(title: "Version", detail: AppUpdateChange.arrow(rest), raw: change)

        case "runtime":
            self.init(title: "Runtime", detail: AppUpdateChange.arrow(rest), raw: change)

        case "role":
            self.init(title: "Role", detail: AppUpdateChange.arrow(rest), raw: change)

        // A resolved-image-digest move: a re-pushed tag or a new build, which happens even when the
        // manifest JSON is byte-identical. Digests are 64 hex characters and the only part anyone reads
        // is the front, so they are shortened here rather than wrapped across four lines.
        case "artifact":
            let (service, diff) = AppUpdateChange.split(rest, at: ":")
            self.init(
                title: "\(service) image digest",
                detail: AppUpdateChange.arrow(diff, transform: AppUpdateChange.shortDigest),
                raw: change)

        case "image":
            let (service, diff) = AppUpdateChange.split(rest, at: ":")
            self.init(title: "\(service) image", detail: AppUpdateChange.arrow(diff), raw: change)

        case "source":
            self.init(
                title: "Source commit",
                detail: AppUpdateChange.arrow(rest, transform: AppUpdateChange.shortCommit),
                raw: change)

        case "service":
            self.init(parsingResource: rest, label: "Service", raw: change)

        case "command":
            let (service, _) = AppUpdateChange.split(rest, at: ":")
            self.init(title: "\(service) command changed", raw: change)

        case "workingDirectory":
            let (service, diff) = AppUpdateChange.split(rest, at: ":")
            self.init(title: "\(service) working directory", detail: AppUpdateChange.arrow(diff), raw: change)

        case "network":
            let (service, diff) = AppUpdateChange.split(rest, at: ":")
            self.init(title: "\(service) network", detail: AppUpdateChange.arrow(diff), raw: change)

        case "capabilities":
            let (service, diff) = AppUpdateChange.split(rest, at: ":")
            self.init(title: "\(service) container capabilities", detail: AppUpdateChange.arrow(diff), raw: change)

        case "devices":
            let (service, diff) = AppUpdateChange.split(rest, at: ":")
            self.init(title: "\(service) devices", detail: AppUpdateChange.arrow(diff), raw: change)

        case "container":
            self.init(parsingResource: rest, label: "Container", raw: change)

        case "port":
            self.init(parsingResource: rest, label: "Port", raw: change)

        case "environment":
            self.init(parsingResource: rest, label: "Environment variable", raw: change)

        case "setting":
            self.init(parsingResource: rest, label: "Setting", raw: change)

        case "dependency":
            self.init(parsingResource: rest, label: "Dependency", raw: change)

        case "endpoint":
            self.init(parsingResource: rest, label: "Endpoint", raw: change)

        case "capability":
            self.init(parsingResource: rest, label: "Capability", raw: change)

        case "data":
            self.init(parsingData: rest, raw: change)

        default:
            // An unrecognized token is shown verbatim. Core's vocabulary grows, and a client that
            // silently dropped what it did not know would quietly stop describing the plan it is asking
            // someone to approve.
            self.init(title: change, raw: change)
        }
    }

    /// `{name}:added:{detail}`, `{name}:removed`, `{name}:changed`, `{name}:{a}->{b}`, and
    /// `{name}:{attribute}:{a}->{b}` — the shape most of Core's per-resource tokens share.
    private init(parsingResource payload: String, label: String, raw: String) {
        let (name, detail) = AppUpdateChange.split(payload, at: ":")
        let subject = "\(label) \(name)"

        if detail.isEmpty || detail == "changed" {
            self.init(title: "\(subject) changed", raw: raw)
            return
        }

        if let (verb, value) = AppUpdateChange.verb(in: detail) {
            self.init(title: "\(subject) \(verb)", detail: value, raw: raw)
            return
        }

        // `{facet}:{a}->{b}` — a named facet of the resource moved, such as a setting's type.
        //
        // Recognized from a closed list rather than from "there is a separator before the arrow". Core's
        // value signatures are colon-delimited themselves — an endpoint is `http:public=True:service=api`
        // — so any structural guess reads the first field of a value as a facet name and mangles exactly
        // the review-class changes this sheet exists to explain.
        if let facet = AppUpdateChange.facets.first(where: { detail.hasPrefix("\($0):") }) {
            self.init(
                title: "\(subject) \(AppUpdateChange.facetNames[facet] ?? facet)",
                detail: AppUpdateChange.arrow(String(detail.dropFirst(facet.count + 1))),
                raw: raw)
            return
        }

        if detail.contains("->") {
            self.init(title: subject, detail: AppUpdateChange.arrow(detail), raw: raw)
            return
        }

        self.init(title: "\(subject) \(detail)", raw: raw)
    }

    private init(parsingData payload: String, raw: String) {
        let (action, detail) = AppUpdateChange.split(payload, at: ":")

        switch action {
        case "added":
            self.init(title: "Data directory added", detail: detail, raw: raw)
        case "removed":
            self.init(title: "Data directory removed", detail: detail, raw: raw)
        case "target":
            self.init(title: "Data directory location", detail: AppUpdateChange.arrow(detail), raw: raw)
        case "compatible":
            // Not a change at all: Core says the existing data works with the target. Saying so beats
            // rendering it as "Data directory changed", which is the opposite of what it means.
            self.init(title: "Data directory is kept as it is", raw: raw)
        default:
            self.init(title: "Data directory changed", raw: raw)
        }
    }

    // MARK: - Parsing

    /// The bare verbs Core writes for a resource that appeared, went away, or was kept, with whatever
    /// value it attached: `added:tcp/8080` yields `("added", "tcp/8080")`.
    private static func verb(in detail: String) -> (String, String?)? {
        for verb in ["added", "removed", "preserved"] {
            if detail == verb {
                return (verb, nil)
            }

            if detail.hasPrefix("\(verb):") {
                return (verb, String(detail.dropFirst(verb.count + 1)))
            }
        }

        return nil
    }

    /// Splits on the first separator only. Every token here is `kind:rest`, and `rest` routinely
    /// contains more separators — a digest is `sha256:…` and splitting it further would be wrong.
    private static func split(_ value: String, at separator: Character) -> (String, String) {
        guard let index = value.firstIndex(of: separator) else { return (value, "") }
        return (String(value[value.startIndex..<index]), String(value[value.index(after: index)...]))
    }

    /// The facets Core names inside a resource token, and how to say them.
    ///
    /// A closed list on purpose: the alternative — treating whatever precedes a separator as a facet —
    /// cannot tell `setting:apiKey:type:string->secret` from `endpoint:api:http:public=True->…`, whose
    /// first field is a protocol, not a facet.
    private static let facets = ["type", "secret", "runtimeType"]

    private static let facetNames = ["runtimeType": "runtime type", "secret": "secret flag"]

    /// `a->b` as `a → b`, with each side put through `transform`. A token with no arrow is a lone value
    /// and is returned as it is; an empty side means Core had nothing to report there.
    ///
    /// Which arrow separates the two values is not simply the first one: a port signature is
    /// `{protocol}:{host}->{container}:public=…`, so a port transition holds three arrows and the middle
    /// one is the separator. Both sides of any transition are the same grammar and therefore carry the
    /// same number of internal arrows, which makes the separator the middle occurrence whenever the
    /// count is odd. An even count cannot be resolved that way and is not guessed at: the value is shown
    /// whole rather than split in the wrong place, so a grammar that changes degrades to raw text
    /// instead of quietly misreporting a change.
    private static func arrow(_ value: String, transform: (String) -> String = { $0 }) -> String? {
        guard !value.isEmpty else { return nil }

        let arrows = value.ranges(of: "->")
        guard !arrows.isEmpty else { return transform(value) }
        guard !arrows.count.isMultiple(of: 2) else { return value }

        let separator = arrows[arrows.count / 2]
        let current = transform(String(value[value.startIndex..<separator.lowerBound]))
        let target = transform(String(value[separator.upperBound...]))
        return "\(current.isEmpty ? "none" : current) → \(target.isEmpty ? "unknown" : target)"
    }

    /// `sha256:` plus the first 12 hex characters. Only a real digest is shortened — anything else is
    /// returned untouched, so a non-digest identifier is never dressed up as one.
    static func shortDigest(_ value: String) -> String {
        let hex = value.hasPrefix("sha256:") ? String(value.dropFirst("sha256:".count)) : value
        guard hex.count == 64, hex.allSatisfy(\.isHexDigit) else { return value }

        return "sha256:\(hex.prefix(12))"
    }

    /// The first 8 characters of a git commit, the length everything else in this project uses.
    static func shortCommit(_ value: String) -> String {
        guard value.count == 40, value.allSatisfy(\.isHexDigit) else { return value }

        return String(value.prefix(8))
    }
}
