#include "hosty/state.hpp"

namespace hosty {

RuntimeState parse_runtime_state(std::string_view value) {
    if (value == "stopped") return RuntimeState::Stopped;
    if (value == "starting") return RuntimeState::Starting;
    if (value == "started" || value == "running") return RuntimeState::Running;
    if (value == "stopping") return RuntimeState::Stopping;
    if (value == "failed") return RuntimeState::Failed;
    return RuntimeState::Unknown;
}

OperationState parse_operation_state(std::string_view value) {
    if (value.empty() || value == "idle" || value == "completed") return OperationState::Idle;
    if (value == "updating") return OperationState::Updating;
    if (value == "failed") return OperationState::Failed;
    return OperationState::Unknown;
}

NotificationLevel parse_notification_level(std::string_view value) {
    if (value == "info") return NotificationLevel::Info;
    if (value == "success") return NotificationLevel::Success;
    if (value == "warning") return NotificationLevel::Warning;
    if (value == "error") return NotificationLevel::Error;
    return NotificationLevel::Unknown;
}

bool is_busy(const AppSummary& app) {
    return app.operation_state == OperationState::Updating ||
           app.runtime_state == RuntimeState::Starting ||
           app.runtime_state == RuntimeState::Stopping;
}

bool is_running(const AppSummary& app) {
    return app.runtime_state == RuntimeState::Running;
}

DashboardCounts count_dashboard(const CoreSnapshot& snapshot) {
    DashboardCounts counts;
    for (const auto& app : snapshot.apps) {
        if (is_busy(app)) ++counts.busy;
        else if (app.runtime_state == RuntimeState::Running) ++counts.running;
        else if (app.runtime_state == RuntimeState::Failed || app.operation_state == OperationState::Failed ||
                 !app.last_error.empty()) ++counts.failed;
        else ++counts.stopped;

        if (app.update.available) {
            ++counts.updates;
            if (app.update.requires_review || app.update.plan_digest.empty()) ++counts.review_updates;
        }
    }
    return counts;
}

std::string_view runtime_state_label(RuntimeState state) {
    switch (state) {
        case RuntimeState::Stopped: return "stopped";
        case RuntimeState::Starting: return "starting";
        case RuntimeState::Running: return "running";
        case RuntimeState::Stopping: return "stopping";
        case RuntimeState::Failed: return "failed";
        case RuntimeState::Unknown: return "unknown";
    }
    return "unknown";
}

std::string_view connection_state_label(ConnectionState state) {
    switch (state) {
        case ConnectionState::Unconfigured: return "setup";
        case ConnectionState::WifiConnecting: return "wifi";
        case ConnectionState::TimeSyncing: return "time";
        case ConnectionState::Authorizing: return "authorize";
        case ConnectionState::Connecting: return "syncing";
        case ConnectionState::Online: return "online";
        case ConnectionState::Stale: return "stale";
        case ConnectionState::Unauthorized: return "revoked";
        case ConnectionState::UnsupportedCore: return "upgrade Core";
        case ConnectionState::Offline: return "offline";
    }
    return "unknown";
}

void ClientState::apply(const ConnectionEvent& event) {
    switch (event.type) {
        case ConnectionEvent::Type::Configured:
            connection_ = ConnectionState::WifiConnecting;
            synchronized_ = false;
            break;
        case ConnectionEvent::Type::WifiConnected:
            connection_ = ConnectionState::TimeSyncing;
            break;
        case ConnectionEvent::Type::WifiLost:
            connection_ = ConnectionState::Offline;
            synchronized_ = false;
            break;
        case ConnectionEvent::Type::TimeReady:
        case ConnectionEvent::Type::Authorized:
        case ConnectionEvent::Type::SyncStarted:
            connection_ = ConnectionState::Connecting;
            break;
        case ConnectionEvent::Type::AuthorizationStarted:
            connection_ = ConnectionState::Authorizing;
            synchronized_ = false;
            break;
        case ConnectionEvent::Type::Unauthorized:
            connection_ = ConnectionState::Unauthorized;
            synchronized_ = false;
            break;
        case ConnectionEvent::Type::SyncCompleted:
            connection_ = ConnectionState::Online;
            synchronized_ = true;
            last_sync_ms_ = event.now_ms;
            break;
        case ConnectionEvent::Type::TransportFailed:
            connection_ = synchronized_ ? ConnectionState::Stale : ConnectionState::Offline;
            break;
        case ConnectionEvent::Type::UnsupportedCore:
            connection_ = ConnectionState::UnsupportedCore;
            synchronized_ = false;
            break;
    }
}

void ClientState::install_snapshot(const CoreSnapshot& snapshot, std::uint64_t now_ms) {
    core_ = snapshot;
    core_.received_at_ms = now_ms;
    last_sync_ms_ = now_ms;
}

void ClientState::install_notifications(const NotificationSnapshot& notifications) {
    notifications_ = notifications;
}

SyncHint ClientState::on_sse_event(std::string_view event_name) {
    if (event_name == "notification") return SyncHint::Notifications;
    if (event_name == "app.changed" || event_name == "app.removed" ||
        event_name == "app.update-check.changed" || event_name == "apps.update-check.changed") {
        return SyncHint::Apps;
    }
    return SyncHint::None;
}

bool ClientState::stale(std::uint64_t now_ms, std::uint64_t threshold_ms) const {
    return !synchronized_ || now_ms < last_sync_ms_ || now_ms - last_sync_ms_ > threshold_ms;
}

}  // namespace hosty

