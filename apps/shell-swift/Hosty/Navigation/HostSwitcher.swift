import HostyKit
import SwiftUI

/// The active host, and the way to another one.
///
/// A host is this client's account, not one of its sections: every destination shows one host's data,
/// and switching is the same gesture as switching accounts elsewhere. It lives in the toolbar of every
/// destination *and* of the pre-session screens — a host that cannot be reached is exactly when the
/// operator needs to leave it, and a switcher that only appeared once signed in would strand them
/// there.
struct HostSwitcher: View {
    let hosts: [HostConnection]
    let activeHost: HostConnection?
    let onSelect: (HostConnection) -> Void
    let onAddHost: () -> Void

    var body: some View {
        Menu {
            if !hosts.isEmpty {
                Picker("Host", selection: selection) {
                    ForEach(hosts) { host in
                        Text(host.displayName).tag(host.origin as HostOrigin?)
                    }
                }
                .pickerStyle(.inline)

                Divider()
            }

            Button("Add a host…", systemImage: "plus") { onAddHost() }
        } label: {
            Label(activeHost?.displayName ?? "No host", systemImage: "server.rack")
                // The name is the point of the control. A toolbar `Label` renders icon-only by
                // default, which leaves the operator looking at a server glyph that could mean any
                // of their hosts.
                .labelStyle(.titleAndIcon)
                .font(.subheadline)
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
    }

    private var selection: Binding<HostOrigin?> {
        Binding(
            get: { activeHost?.origin },
            set: { origin in
                guard let host = hosts.first(where: { $0.origin == origin }) else { return }
                onSelect(host)
            })
    }
}
