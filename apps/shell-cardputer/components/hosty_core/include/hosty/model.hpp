#pragma once

#include "hosty/bounded.hpp"

#include <cstdint>
#include <string_view>

namespace hosty {

inline constexpr std::string_view kMinimumCoreVersion = "0.73.0";
inline constexpr std::size_t kMaximumApps = 64;
inline constexpr std::size_t kMaximumNotifications = 16;

enum class ConnectionState : std::uint8_t {
    Unconfigured,
    WifiConnecting,
    TimeSyncing,
    Authorizing,
    Connecting,
    Online,
    Stale,
    Unauthorized,
    UnsupportedCore,
    Offline,
};

enum class RuntimeState : std::uint8_t {
    Unknown,
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
};

enum class OperationState : std::uint8_t {
    Idle,
    Updating,
    Failed,
    Unknown,
};

enum class NotificationLevel : std::uint8_t { Info, Success, Warning, Error, Unknown };
enum class View : std::uint8_t { Dashboard, Apps, Updates, Device };

struct AppUpdateState {
    bool checked = false;
    bool available = false;
    bool requires_review = false;
    bool has_error = false;
    FixedString<96> plan_digest;
    FixedString<128> error;
};

struct AppSummary {
    FixedString<96> id;
    FixedString<64> display_name;
    FixedString<24> version;
    RuntimeState runtime_state = RuntimeState::Unknown;
    OperationState operation_state = OperationState::Unknown;
    bool system = false;
    bool autostart = true;
    bool live = false;
    bool logs_available = false;
    FixedString<160> last_error;
    AppUpdateState update;
};

struct FleetUpdateState {
    bool known = false;
    bool running = false;
    FixedString<40> last_completed_at;
};

struct CoreUpdateState {
    bool known = false;
    bool available = false;
    FixedString<40> checked_at;
    FixedString<96> error;
};

struct CoreSnapshot {
    FixedString<24> version;
    FixedString<40> server_time;
    FixedVector<AppSummary, kMaximumApps> apps;
    FleetUpdateState update_check;
    CoreUpdateState core_update;
    std::uint64_t received_at_ms = 0;
};

struct Notification {
    FixedString<72> id;
    FixedString<96> app_id;
    FixedString<120> title;
    FixedString<256> body;
    FixedString<40> created_at;
    NotificationLevel level = NotificationLevel::Unknown;
    bool read = false;
};

struct NotificationSnapshot {
    FixedVector<Notification, kMaximumNotifications> items;
    std::uint32_t unread_count = 0;
    FixedString<40> updated_at;
};

struct LogTail {
    FixedString<96> app_id;
    FixedString<2048> text;
};

struct SessionInfo {
    bool authenticated = false;
    bool administrator = false;
    FixedString<64> user_id;
    FixedString<64> display_name;
    FixedString<24> role;
    FixedString<16> credential_kind;
};

struct DeviceCode {
    FixedString<96> device_code;
    FixedString<16> user_code;
    FixedString<192> verification_uri;
    std::uint32_t interval_seconds = 5;
    std::uint32_t expires_in_seconds = 0;
};

enum class DeviceTokenStatus : std::uint8_t { Pending, Approved, Denied, Expired, Unknown };

struct DeviceTokenResult {
    DeviceTokenStatus status = DeviceTokenStatus::Unknown;
    FixedString<96> token;
};

struct DashboardCounts {
    std::uint16_t running = 0;
    std::uint16_t stopped = 0;
    std::uint16_t busy = 0;
    std::uint16_t failed = 0;
    std::uint16_t updates = 0;
    std::uint16_t review_updates = 0;
};

[[nodiscard]] RuntimeState parse_runtime_state(std::string_view value);
[[nodiscard]] OperationState parse_operation_state(std::string_view value);
[[nodiscard]] NotificationLevel parse_notification_level(std::string_view value);
[[nodiscard]] bool is_busy(const AppSummary& app);
[[nodiscard]] bool is_running(const AppSummary& app);
[[nodiscard]] DashboardCounts count_dashboard(const CoreSnapshot& snapshot);
[[nodiscard]] std::string_view runtime_state_label(RuntimeState state);
[[nodiscard]] std::string_view connection_state_label(ConnectionState state);

}  // namespace hosty
