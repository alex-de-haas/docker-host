import HostyKit
import SwiftUI

struct AppRow: View {
    let app: AppSummary
    let icons: AppIconStore

    /// Acts on the waiting update. Nil where the row has nothing to act with — the marker then stays a
    /// marker, which is what it is in a preview or a read-only listing.
    var onUpdate: (() -> Void)?

    /// True while the host already owns work on this app. The marker stays visible and stops responding,
    /// rather than vanishing and taking the row's explanation of itself with it.
    var isBusy = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                accessibleLayout
            } else {
                standardLayout
            }
        }
        .padding(.vertical, 2)
    }

    private var standardLayout: some View {
        HStack(spacing: 12) {
            // Combined here rather than on the whole row: the update marker is a control of its own, and
            // an element that swallowed it would leave VoiceOver reading "update available" with no way
            // to act on it.
            HStack(spacing: 12) {
                AppIconView(app: app, icons: icons)

                VStack(alignment: .leading, spacing: 3) {
                    title
                    metadata
                    firstProblem
                }

                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)

            updateControl
        }
    }

    private var accessibleLayout: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    AppIconView(app: app, icons: icons)
                    title
                }

                RuntimeStateBadge(state: app.runtimeState, operating: app.isOperating)

                Text(accessibleMetadata)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                firstProblem
            }
            .accessibilityElement(children: .combine)

            // At these sizes the marker is a labelled row of its own rather than a glyph at the far edge,
            // where it would be both unreadable and an awkward target.
            if app.updateCheck?.updateAvailable == true {
                if let onUpdate {
                    Button(action: onUpdate) {
                        Label(updateActionLabel, systemImage: "arrow.up.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .disabled(isBusy)
                } else {
                    Label("Update available", systemImage: "arrow.up.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.blue)
                }
            }
        }
    }

    private var title: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) {
                Text(app.displayName)
                    .font(.body)

                badges
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(app.displayName)
                    .font(.body)

                HStack(spacing: 6) { badges }
            }
        }
    }

    @ViewBuilder
    private var badges: some View {
        if app.system {
            // Everything the "System" section used to say, in the row that needs it. It marks ownership,
            // not capability: the host installed and manages this app, and every lifecycle verb applies to
            // it exactly as it does to the rest.
            BadgeChip(text: "System", tint: .secondary)
        }

        if app.live {
            // A live source app runs from the operator's own folder: its contract is adopted on restart
            // and it has no reviewed-update path at all.
            BadgeChip(text: "Live", tint: .purple)
        }
    }

    private var metadata: some View {
        HStack(spacing: 8) {
            RuntimeStateBadge(state: app.runtimeState, operating: app.isOperating)

            Text(app.version)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let runtime = app.selectedRuntime {
                Text(runtime)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var accessibleMetadata: String {
        if let runtime = app.selectedRuntime {
            return "Version \(app.version), runtime \(runtime)"
        }

        return "Version \(app.version)"
    }

    @ViewBuilder
    private var firstProblem: some View {
        if let problem = app.problems.first {
            Label(problem, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
                .lineLimit(2)
        }
    }

    /// The marker, and the action it is: one tap applies a routine update, or opens the plan of one that
    /// has to be read first.
    @ViewBuilder
    private var updateControl: some View {
        if app.updateCheck?.updateAvailable == true {
            if let onUpdate {
                Button(action: onUpdate) {
                    Image(systemName: "arrow.up.circle.fill")
                        .foregroundStyle(isBusy ? Color.secondary : Color.blue)
                        // The glyph is small and sits at the very edge of a row that is itself a
                        // navigation link. Without a target of its own, most taps aimed at it open the
                        // app instead of updating it.
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                // Borderless keeps the tap on the glyph. A `List` row gives a plain button the whole
                // row, which here would mean the update runs whenever the row is touched at all.
                .buttonStyle(.borderless)
                .disabled(isBusy)
                .accessibilityLabel(updateActionLabel)
            } else {
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(.blue)
                    .accessibilityLabel("Update available")
            }
        }
    }

    /// Says which of the two things the tap does, because the marker looks the same either way.
    private var updateActionLabel: String {
        app.hasRoutineUpdate ? "Update \(app.displayName)" : "Review update for \(app.displayName)"
    }
}

struct BadgeChip: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.15), in: Capsule())
            .foregroundStyle(tint)
            .fixedSize(horizontal: true, vertical: false)
    }
}

#if DEBUG
private var previewIcons: AppIconStore { AppIconStore(previewImages: PreviewFixtures.icons) }

#Preview("App rows") {
    let icons = previewIcons

    List {
        AppRow(app: PreviewFixtures.runningApp, icons: icons)
        AppRow(app: PreviewFixtures.systemApp, icons: icons)
    }
}

#Preview("App rows — accessibility size") {
    let icons = previewIcons

    List {
        AppRow(app: PreviewFixtures.runningApp, icons: icons)
        AppRow(app: PreviewFixtures.systemApp, icons: icons)
    }
    .environment(\.dynamicTypeSize, .accessibility3)
}
#endif
