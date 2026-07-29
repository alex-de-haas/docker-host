import HostyKit
import SwiftUI

/// Adding a host: type an address, and confirm a Hosty Core actually answers there before storing it.
///
/// The probe is `GET /api/core/status`, which is public — so an address can be checked before there is any
/// credential to check it with, and a typo is caught here rather than as a confusing failure after signing
/// in.
struct AddHostView: View {
    let onAdd: (HostConnection) -> Void

    @State private var address = ""
    @State private var label = ""
    @State private var probe: ProbeState = .idle
    /// The candidate that actually answered, which is what gets stored — the typed text may not name a
    /// scheme at all.
    @State private var resolved: HostOrigin?
    @Environment(\.dismiss) private var dismiss

    private enum ProbeState: Equatable {
        case idle
        case checking
        case found(version: String)
        case failed(String)

        var message: String {
            switch self {
            case .idle:
                // No longer promises a scheme, because Hosty no longer picks one: without http:// or
                // https:// both are tried, and whichever answers is the one stored.
                "Without http:// or https://, Hosty tries both."
            case .checking:
                "Checking…"
            case .found(let version):
                "Hosty Core \(version)"
            case .failed(let message):
                message
            }
        }

        var icon: String? {
            switch self {
            case .idle, .checking: nil
            case .found: "checkmark.circle"
            case .failed: "exclamationmark.triangle"
            }
        }

        var tint: Color {
            switch self {
            case .idle, .checking: .secondary
            case .found: .green
            case .failed: .red
            }
        }
    }

    private var parsedOrigin: HostOrigin? {
        try? HostOrigin(parsing: address)
    }

    var body: some View {
        Form {
            Section {
                TextField("192.168.1.50:7070", text: $address)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                    // Only when it actually changes. Writing state on every keystroke re-renders the
                    // section around the field for no reason, which is the other half of the focus loss.
                    .onChange(of: address) {
                        if probe != .idle {
                            probe = .idle
                        }
                    }

                TextField("Name (optional)", text: $label)
                    .autocorrectionDisabled()
            } header: {
                Text("Address")
            } footer: {
                statusFooter
            }

            Section {
                Button("Check") { Task { await check() } }
                    .disabled(parsedOrigin == nil || probe == .checking)

                if case .found = probe {
                    Button("Add host") { add() }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Add a Hosty host")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
        }
    }

    /// One view, always — never a `switch` that yields `Text` in some states and `Label` in others.
    ///
    /// A `@ViewBuilder` switch changes the *type* of the section's footer when the state changes, and
    /// typing changes the state on the very first keystroke after a check. SwiftUI treats that as a
    /// structural change, rebuilds the section, and the `TextField` inside it loses first responder — so
    /// the first character lands and everything after it goes nowhere. Keeping one view with varying
    /// content keeps the field's identity stable while the operator types.
    private var statusFooter: some View {
        Label {
            Text(probe.message)
        } icon: {
            if let icon = probe.icon {
                Image(systemName: icon)
            }
        }
        .foregroundStyle(probe.tint)
    }

    private func check() async {
        // The address this probe is about. Editing the field while a probe is in flight resets the
        // displayed state but cannot cancel the request, so every publish below is guarded against it:
        // otherwise a late answer for the old address would set `.found` and arm "Add host" while the
        // field showed something else, and the button would store the host nobody was looking at.
        let submitted = address

        let candidates: [HostOrigin]
        do {
            candidates = try HostOrigin.candidates(for: submitted)
        } catch {
            publish(.failed(error.localizedDescription), resolved: nil, for: submitted)
            return
        }

        probe = .checking

        // Try each candidate in turn, keeping the first *useful* answer. A transport failure on the
        // leading candidate is expected when the operator typed a bare LAN address — https simply is not
        // listening — so it moves on rather than reporting. Anything conclusive stops here.
        var lastFailure: String?
        for origin in candidates {
            do {
                let status = try await CoreClient(origin: origin).status()

                // Something answered. Whether it is *Hosty* is a separate question — a well-formed JSON
                // reply from an unrelated service must not be accepted as a host.
                guard status.isHostyCore else {
                    lastFailure = "Something answered at \(origin.displayName), but it is not a Hosty host."
                    continue
                }

                // Caught here rather than after signing in, where it would look like a login that keeps
                // failing for no stated reason.
                guard status.isSupportedVersion else {
                    publish(
                        .failed(
                            """
                            \(origin.displayName) runs Hosty \(status.version). \
                            This app needs \(PlatformVersion.minimumSupported) or newer — update the host first.
                            """),
                        resolved: nil,
                        for: submitted)
                    return
                }

                publish(.found(version: status.version), resolved: origin, for: submitted)
                return
            } catch {
                lastFailure = error.localizedDescription
            }
        }

        publish(.failed(lastFailure ?? "Could not reach that address."), resolved: nil, for: submitted)
    }

    /// Publishes a probe outcome, unless the operator has moved on to a different address.
    private func publish(_ outcome: ProbeState, resolved origin: HostOrigin?, for submitted: String) {
        guard submitted == address else { return }

        probe = outcome
        resolved = origin
    }

    private func add() {
        // Whichever candidate actually answered — never the typed text re-parsed, which would drop the
        // scheme that was discovered by probing.
        guard let resolved else { return }

        onAdd(HostConnection(origin: resolved, name: label))
        dismiss()
    }
}
