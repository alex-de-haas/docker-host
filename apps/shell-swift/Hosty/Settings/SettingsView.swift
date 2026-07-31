import HostyKit
import SwiftUI

/// What belongs to this device: the hosts saved on it, and the session on the active one.
///
/// The host-level configuration the browser Shell keeps in Settings — users, Core settings, shared
/// mounts — has no counterpart here yet, so this tab is deliberately small rather than merged away.
/// The three-destination shape is the part the two clients share.
struct SettingsView: View {
    let hosts: [HostConnection]
    let activeHost: HostConnection?
    let session: HostSession?
    let onSelect: (HostConnection) -> Void
    let onAddHost: () -> Void
    let onForget: (HostConnection) -> Void

    @State private var hostPendingRemoval: HostConnection?
    @State private var confirmingRemoval = false

    var body: some View {
        List {
            Section("Hosts") {
                ForEach(hosts) { host in
                    Button {
                        onSelect(host)
                    } label: {
                        HostRow(host: host, isActive: host.origin == activeHost?.origin)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Forget \(host.displayName)…", role: .destructive) { requestRemoval(of: host) }
                    }
                    .swipeActions {
                        Button("Forget", role: .destructive) { requestRemoval(of: host) }
                    }
                }

                Button("Add a host…", systemImage: "plus") { onAddHost() }
            }

            if let session, let user = session.user {
                Section("Session") {
                    LabeledContent("Signed in as", value: user.name)
                    Button("Sign out", role: .destructive) {
                        Task { await session.signOut() }
                    }
                }
            }
        }
        .navigationTitle("Settings")
        .navigationSubtitle(activeHost?.displayName ?? "No host")
        // Inline and leading like its peer destinations. A tab bar already names the screen, so a large
        // title is a band of chrome saying it twice — and three tabs that disagreed about their own
        // chrome would read as three different apps.
        .toolbarTitleDisplayMode(.inlineLarge)
        #if os(iOS)
        .contentMargins(.top, 0, for: .scrollContent)
        #endif
        .confirmationDialog(
            "Forget this host?",
            isPresented: $confirmingRemoval,
            presenting: hostPendingRemoval
        ) { host in
            Button("Forget \(host.displayName)", role: .destructive) {
                onForget(host)
                hostPendingRemoval = nil
            }

            Button("Cancel", role: .cancel) { hostPendingRemoval = nil }
        } message: { host in
            Text("The saved sign-in for \(host.displayName) will also be removed from this device.")
        }
    }

    private func requestRemoval(of host: HostConnection) {
        hostPendingRemoval = host
        confirmingRemoval = true
    }
}

private struct HostRow: View {
    let host: HostConnection
    let isActive: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(host.displayName)
                    .font(.body)
                    .foregroundStyle(.primary)

                if host.name != nil {
                    Text(host.origin.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 0)

            if isActive {
                Image(systemName: "checkmark")
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel("Active host")
            }
        }
        .contentShape(Rectangle())
    }
}
