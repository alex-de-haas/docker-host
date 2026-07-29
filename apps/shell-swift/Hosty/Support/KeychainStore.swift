import Foundation
import HostyKit
import Security

/// Stores one Core session id per host, in the Keychain.
///
/// Per host, keyed by the full origin, because a credential is only ever valid for the host that issued it
/// — and because two Hosty hosts commonly differ only by port, which `HostOrigin` treats as identity and a
/// cookie jar does not.
nonisolated struct KeychainStore {
    static let shared = KeychainStore()

    private let service = "com.haas.hosty.session"

    func sessionID(for origin: HostOrigin) -> String? {
        var query = baseQuery(for: origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data,
            let value = String(data: data, encoding: .utf8),
            !value.isEmpty
        else {
            return nil
        }

        return value
    }

    func setSessionID(_ id: String?, for origin: HostOrigin) {
        guard let id, !id.isEmpty else {
            removeSessionID(for: origin)
            return
        }

        let data = Data(id.utf8)
        let query = baseQuery(for: origin)

        // Update first, then insert. SecItemAdd fails with errSecDuplicateItem rather than replacing, so
        // signing in again on a host that already had a session would otherwise keep the dead credential.
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated != errSecSuccess else {
            return
        }

        var insert = query
        insert[kSecValueData as String] = data
        // After first unlock rather than when-unlocked: the app refreshes app state in the background, and
        // a credential it cannot read then is a session that appears to have expired.
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(insert as CFDictionary, nil)
    }

    func removeSessionID(for origin: HostOrigin) {
        SecItemDelete(baseQuery(for: origin) as CFDictionary)
    }

    private func baseQuery(for origin: HostOrigin) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin.url.absoluteString,
            // Without this macOS uses the old file-based keychain, whose behavior around access and
            // duplicates differs from iOS. Opting in keeps one set of semantics across both platforms.
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}
