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

bool needs_attention(const AppSummary& app) {
    const bool transitioning = app.runtime_state == RuntimeState::Starting || app.runtime_state == RuntimeState::Stopping;
    return app.configuration_required || app.permission_error ||
        (app.permissions_known && app.missing_permissions) || app.restart_required || app.update.has_error ||
        !app.last_error.empty() || app.operation_state == OperationState::Failed ||
        app.runtime_state == RuntimeState::Unknown || app.runtime_state == RuntimeState::Failed ||
        (app.operation_state != OperationState::Updating && !transitioning && !app.health_healthy &&
         ((is_running(app) && app.health_degraded) || (app.last_operation_update && app.update_needs_attention)));
}

DashboardCounts count_dashboard(const CoreSnapshot& snapshot) {
    DashboardCounts counts;
    for (const auto& app : snapshot.apps) {
        // Attention is independent of runtime: a running app can still be unhealthy.
        if (is_running(app)) ++counts.running;
        if (is_busy(app)) ++counts.busy;
        if (app.runtime_state == RuntimeState::Stopped) ++counts.stopped;
        if (needs_attention(app)) ++counts.attention;
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

bool ClientState::predict_runtime_state(std::string_view app_id, RuntimeState state) {
    for (auto& app : core_.apps) {
        if (app.id.view() != app_id) continue;
        if (app.runtime_state == state) return false;
        app.runtime_state = state;
        return true;
    }
    return false;
}

bool ClientState::stale(std::uint64_t now_ms, std::uint64_t threshold_ms) const {
    return !synchronized_ || now_ms < last_sync_ms_ || now_ms - last_sync_ms_ > threshold_ms;
}

}  // namespace hosty

