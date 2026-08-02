#pragma once

#include "hosty/model.hpp"

#include <cstdint>
#include <string_view>

namespace hosty {

enum class SyncHint : std::uint8_t { None, Apps, Notifications, Full };

struct ConnectionEvent {
    enum class Type : std::uint8_t {
        Configured,
        WifiConnected,
        WifiLost,
        TimeReady,
        AuthorizationStarted,
        Authorized,
        Unauthorized,
        SyncStarted,
        SyncCompleted,
        TransportFailed,
        UnsupportedCore,
    } type;
    std::uint64_t now_ms = 0;
};

class ClientState {
public:
    void apply(const ConnectionEvent& event);
    void install_snapshot(const CoreSnapshot& snapshot, std::uint64_t now_ms);
    void install_notifications(const NotificationSnapshot& notifications);

    // Show a lifecycle transition the moment the operator asks for it, without waiting to be told.
    //
    // Core does publish `starting` and `stopping`, but the device only learns of them by re-reading
    // /api/apps, and that round-trip costs about a second and a half — dominated by a fresh TLS
    // handshake. An app frequently passes through the intermediate state faster than that, so the
    // snapshot that finally arrives already says `running` and the operator sees nothing happen
    // between pressing the key and the app changing colour.
    //
    // This is a local prediction, not a fact: the next snapshot overwrites it unconditionally, so a
    // failed or refused operation corrects itself within one sync rather than sticking.
    [[nodiscard]] bool predict_runtime_state(std::string_view app_id, RuntimeState state);
    [[nodiscard]] SyncHint on_sse_event(std::string_view event_name);
    [[nodiscard]] bool stale(std::uint64_t now_ms, std::uint64_t threshold_ms) const;

    [[nodiscard]] ConnectionState connection() const { return connection_; }
    [[nodiscard]] const CoreSnapshot& core() const { return core_; }
    [[nodiscard]] const NotificationSnapshot& notifications() const { return notifications_; }
    [[nodiscard]] std::uint64_t last_sync_ms() const { return last_sync_ms_; }
    [[nodiscard]] bool synchronized() const { return synchronized_; }

private:
    ConnectionState connection_ = ConnectionState::Unconfigured;
    CoreSnapshot core_;
    NotificationSnapshot notifications_;
    std::uint64_t last_sync_ms_ = 0;
    bool synchronized_ = false;
};

}  // namespace hosty

