import Foundation
import HostyKit
import Observation

/// Top-level app state: the hosts the operator has added, and the one currently open.
@Observable
final class HostyModel {
    private(set) var hosts: [HostConnection]
    private(set) var session: HostSession?
    private(set) var appsModel: AppsModel?

    private let store: HostStore
    private let keychain: KeychainStore

    init(store: HostStore = HostStore(), keychain: KeychainStore = .shared) {
        self.store = store
        self.keychain = keychain
        self.hosts = store.hosts()

        if let active = store.activeHost() {
            activate(active)
        }
    }

    var activeHost: HostConnection? { session?.connection }

    func add(_ connection: HostConnection) {
        // Adding a host that is already known re-selects it rather than duplicating it; `HostConnection`
        // is identified by its origin, so the operator's label is the only thing that could differ.
        if !hosts.contains(where: { $0.origin == connection.origin }) {
            hosts.append(connection)
            store.save(hosts: hosts)
        }

        select(connection)
    }

    func select(_ connection: HostConnection) {
        guard session?.connection.origin != connection.origin else {
            return
        }

        store.setActiveHost(connection)
        activate(connection)
    }

    func remove(_ connection: HostConnection) {
        hosts.removeAll { $0.origin == connection.origin }
        store.save(hosts: hosts)

        // Forgetting a host forgets its credential too. Leaving one behind would silently sign the
        // operator back in if they ever re-added the same address.
        keychain.removeSessionID(for: connection.origin)

        if session?.connection.origin == connection.origin {
            let next = hosts.first
            store.setActiveHost(next)
            if let next {
                activate(next)
            } else {
                session = nil
                appsModel = nil
            }
        }
    }

    /// Builds the session and its app model together so every navigation column observes the same app
    /// collection. This is what lets the list drive a detail column without creating a second event stream.
    private func activate(_ connection: HostConnection) {
        let session = HostSession(connection: connection, keychain: keychain)
        self.session = session
        self.appsModel = AppsModel(session: session)
    }
}
