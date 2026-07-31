import HostyKit
import SwiftUI

/// The app's runtime state, as a person reads it.
///
/// All five states are represented. Collapsing `starting`/`stopping` into "stopped" would be the exact
/// mistake Core's own vocabulary exists to prevent — an app mid-transition is not an app at rest.
struct RuntimeStateBadge: View {
    let state: AppRuntimeState
    var operating: Bool = false

    var body: some View {
        Label {
            Text(title)
        } icon: {
            if state.isBusy || operating {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: symbol)
            }
        }
        .font(.caption)
        .foregroundStyle(tint)
        .labelStyle(.titleAndIcon)
    }

    private var title: String {
        // An update owns the record while it applies, and it outranks the runtime state outright — including
        // while that state is itself busy. Mid-apply the app legitimately cycles through stopping and
        // starting, and reporting those describes the mechanism rather than what the operator asked for.
        operating ? "Updating…" : state.title
    }

    private var symbol: String { state.symbol }

    private var tint: Color { state.tint }
}

/// How a runtime state is named and coloured, in one place.
///
/// Every surface that shows a state shows all five: this badge on a management row, and the dot on a
/// launcher tile. Collapsing `starting`/`stopping` into "stopped" would be the exact mistake Core's
/// vocabulary exists to prevent, and so would collapsing `unknown` into it — an app nobody can classify
/// is not an app at rest. Held here rather than restated per view, because two lists of words and
/// colours for the same five states drift, and the one that drifts is the one shown least often.
extension AppRuntimeState {
    var title: String {
        switch self {
        case .running: "Running"
        case .starting: "Starting…"
        case .stopping: "Stopping…"
        case .stopped: "Stopped"
        case .unknown: "Unknown"
        }
    }

    var symbol: String {
        switch self {
        case .running: "circle.fill"
        case .starting, .stopping: "circle.dotted"
        case .stopped: "circle"
        // Not an error: Core reports `unknown` for something observed but not classifiable, such as a
        // partial multi-service outage. Worth noticing, not worth alarming about.
        case .unknown: "questionmark.circle"
        }
    }

    var tint: Color {
        switch self {
        case .running: .green
        case .starting, .stopping: .orange
        case .stopped: .secondary
        case .unknown: .yellow
        }
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 8) {
        RuntimeStateBadge(state: .running)
        RuntimeStateBadge(state: .starting)
        RuntimeStateBadge(state: .stopping)
        RuntimeStateBadge(state: .stopped)
        RuntimeStateBadge(state: .unknown)
        RuntimeStateBadge(state: .stopped, operating: true)
    }
    .padding()
}
