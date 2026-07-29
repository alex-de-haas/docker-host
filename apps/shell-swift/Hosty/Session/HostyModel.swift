import Foundation
import HostyKit
import Observation

/// Top-level app state: the hosts the operator has added, and the one currently open.
@Observable
final class HostyModel {
    private(set) var hosts: [HostConnection]
    private(set) var session: HostSession?

    private let store: HostStore
    private let keychain: KeychainStore

    init(store: HostStore = HostStore(), keychain: KeychainStore = .shared) {
        self.store = store
        self.keychain = keychain
        self.hosts = store.hosts()

        if let active = store.activeHost() {
            self.session = HostSession(connection: active, keychain: keychain)
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
        session = HostSession(connection: connection, keychain: keychain)
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
            session = next.map { HostSession(connection: $0, keychain: keychain) }
        }
    }
}
