import HostyKit
import SwiftUI

struct AppRow: View {
    let app: AppSummary
    let icons: AppIconStore
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
        .accessibilityElement(children: .combine)
    }

    private var standardLayout: some View {
        HStack(spacing: 12) {
            AppIconView(app: app, icons: icons)

            VStack(alignment: .leading, spacing: 3) {
                title
                metadata
                firstProblem
            }

            Spacer(minLength: 0)

            updateIcon
        }
    }

    private var accessibleLayout: some View {
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

            if app.updateCheck?.updateAvailable == true {
                Label("Update available", systemImage: "arrow.up.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.blue)
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

    @ViewBuilder
    private var updateIcon: some View {
        if app.updateCheck?.updateAvailable == true {
            Image(systemName: "arrow.up.circle.fill")
                .foregroundStyle(.blue)
                .accessibilityLabel("Update available")
        }
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
