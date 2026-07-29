import Foundation
import HostyKit

/// The hosts this app knows about, and which one is showing.
///
/// Only the list and the selection live here. Credentials never do — they belong in the Keychain
/// (`KeychainStore`), and `UserDefaults` is neither private nor protected at rest.
nonisolated struct HostStore {
    private let defaults: UserDefaults
    private let hostsKey = "hosty.hosts"
    private let activeKey = "hosty.activeHost"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func hosts() -> [HostConnection] {
        guard let data = defaults.data(forKey: hostsKey) else {
            return []
        }

        return (try? JSONDecoder().decode([HostConnection].self, from: data)) ?? []
    }

    func save(hosts: [HostConnection]) {
        guard let data = try? JSONEncoder().encode(hosts) else {
            return
        }

        defaults.set(data, forKey: hostsKey)
    }

    func activeHost() -> HostConnection? {
        guard let raw = defaults.string(forKey: activeKey), let origin = try? HostOrigin(parsing: raw) else {
            return nil
        }

        // The selection is stored as an origin and resolved against the list, so a host removed on one
        // launch cannot come back as a dangling selection on the next.
        return hosts().first { $0.origin == origin }
    }

    func setActiveHost(_ host: HostConnection?) {
        guard let host else {
            defaults.removeObject(forKey: activeKey)
            return
        }

        defaults.set(host.origin.url.absoluteString, forKey: activeKey)
    }
}
