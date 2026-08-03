#include "firmware_app.hpp"

#include "hosty/endpoint.hpp"
#include "hosty/semver.hpp"

#include <driver/gpio.h>
#include <esp_app_desc.h>
#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_netif_sntp.h>
#include <esp_ota_ops.h>
#include <esp_pm.h>
#include <esp_sleep.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <nvs_flash.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <iterator>

namespace {

constexpr const char* kTag = "hosty_firmware";
constexpr EventBits_t kSyncApps = BIT0;
constexpr EventBits_t kSyncNotifications = BIT1;
constexpr EventBits_t kFullSync = BIT2;
constexpr EventBits_t kTransportFailed = BIT3;
constexpr EventBits_t kUnauthorized = BIT4;
constexpr EventBits_t kCommandFinished = BIT5;
constexpr EventBits_t kAppsSyncFinished = BIT6;
constexpr EventBits_t kAllTransportEvents =
    kSyncApps | kSyncNotifications | kFullSync | kTransportFailed | kUnauthorized |
    kCommandFinished | kAppsSyncFinished;
constexpr gpio_num_t kKeyboardInterruptPin = GPIO_NUM_11;
constexpr std::uint32_t kEventStreamStackBytes = 16'384;
constexpr std::uint32_t kCommandStackBytes = 8'192;
constexpr std::uint32_t kSyncStackBytes = 10'240;

constexpr std::uint32_t kEventStreamHealthyLifetimeMs = 60'000;
constexpr std::uint32_t kActiveLoopIntervalMs = 20;
constexpr std::uint32_t kMotionStandbyIntervalMs = 250;
constexpr std::uint32_t kIdleStandbyIntervalMs = 1'000;
constexpr std::array<std::uint32_t, 4> kDisplayTimeouts{15'000, 30'000, 60'000, 120'000};
constexpr std::array<std::uint32_t, 3> kEcoAlertIntervals{5 * 60'000, 10 * 60'000, 30 * 60'000};

int month_number(std::string_view month) {
    constexpr std::string_view months[] = {
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    };
    for (int index = 0; index < 12; ++index) {
        if (month == months[index]) return index + 1;
    }
    return 0;
}

// Howard Hinnant's civil-calendar transform, used only to compare the SNTP
// epoch against the firmware build timestamp without relying on the configured
// display time zone.
std::int64_t days_from_civil(int year, unsigned month, unsigned day) {
    year -= month <= 2;
    const int era = (year >= 0 ? year : year - 399) / 400;
    const unsigned year_of_era = static_cast<unsigned>(year - era * 400);
    const unsigned adjusted_month = static_cast<unsigned>(static_cast<int>(month) + (month > 2 ? -3 : 9));
    const unsigned day_of_year = (153U * adjusted_month + 2U) / 5U + day - 1U;
    const unsigned day_of_era = year_of_era * 365U + year_of_era / 4U - year_of_era / 100U + day_of_year;
    return static_cast<std::int64_t>(era) * 146097 + static_cast<std::int64_t>(day_of_era) - 719468;
}

std::time_t build_time_floor() {
    const esp_app_desc_t* description = esp_app_get_description();
    if (description == nullptr) return 0;
    char month[4]{};
    int day = 0;
    int year = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;
    if (std::sscanf(description->date, "%3s %d %d", month, &day, &year) != 3 ||
        std::sscanf(description->time, "%d:%d:%d", &hour, &minute, &second) != 3) {
        return 0;
    }
    const int numeric_month = month_number(month);
    if (numeric_month == 0) return 0;
    return static_cast<std::time_t>(days_from_civil(year, static_cast<unsigned>(numeric_month),
                                                    static_cast<unsigned>(day)) * 86'400 +
                                    hour * 3'600 + minute * 60 + second);
}

bool clock_meets_build_floor() {
    const std::time_t current = std::time(nullptr);
    const std::time_t floor = build_time_floor();
    return floor > 0 && current >= floor;
}

char lower_character(char character) {
    return static_cast<char>(std::tolower(static_cast<unsigned char>(character)));
}

const char* wake_reason_name(hosty::WakeReason reason) {
    switch (reason) {
        case hosty::WakeReason::Keyboard: return "keyboard";
        case hosty::WakeReason::Motion: return "motion";
        case hosty::WakeReason::Notification: return "notification";
        case hosty::WakeReason::None: return "unspecified";
    }
    return "unknown";
}

}  // namespace

void FirmwareApp::run() {
    main_task_ = xTaskGetCurrentTaskHandle();
    if (!initialize()) {
        ESP_LOGE(kTag, "Firmware initialization failed");
        return;
    }

    std::uint8_t connection_failures = 0;
    while (!connect_network()) {
        ++connection_failures;
        const bool setting_time = state_.connection() == hosty::ConnectionState::TimeSyncing;
        const bool persistent_time_failure = setting_time && connection_failures >= 6;
        if (!setting_time || persistent_time_failure) {
            hosty::FixedString<192> retry_message;
            static_cast<void>(retry_message.append(persistent_time_failure
                ? "HTTPS is waiting for the device clock."
                : ui_.status_message.view()));
            static_cast<void>(retry_message.append("\nAutomatic retry in 5 seconds\nF4 edits device settings"));
            show_overlay(persistent_time_failure ? "Time unavailable" : "Connection retry", retry_message.view());
        }
        render();
        const std::uint64_t retry_at_ms = now_ms() + 5'000;
        while (now_ms() < retry_at_ms) {
            hardware_.update();
            cardputer::KeyInput key;
            if (hardware_.keyboard_activity_pending() && hardware_.read_key(key)) {
                if (key.code == cardputer::KeyCode::F4) {
                    static_cast<void>(configure_device());
                    esp_restart();
                }
                if (key.code == cardputer::KeyCode::Enter) break;
            }
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
        }
        if (ui_.overlay_visible) close_overlay();
    }

    while (!authorize()) {
        if (ui_.status_message.empty()) set_status("Authorization retry");
        show_overlay("Authorization retry", ui_.status_message.view());
        render();
        vTaskDelay(pdMS_TO_TICKS(2'000));
        close_overlay();
    }
    image_health_eligible_ = full_sync();
    mark_image_healthy_when_ready();

    if (xTaskCreate(&FirmwareApp::sse_task_entry, "hosty_sse", kEventStreamStackBytes,
                    this, 4, &sse_task_handle_) != pdPASS) {
        ESP_LOGE(kTag, "Unable to allocate event-stream task");
        set_status("Event stream unavailable");
    }
    static_cast<void>(power_.tick(now_ms(), true, 0));
    main_loop();
}

bool FirmwareApp::initialize() {
    boot_start_ms_ = now_ms();
    esp_err_t nvs = nvs_flash_init();
    if (nvs == ESP_ERR_NVS_NO_FREE_PAGES || nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        if (nvs_flash_erase() != ESP_OK) return false;
        nvs = nvs_flash_init();
    }
    if (nvs != ESP_OK || !hardware_.begin()) return false;
    hardware_.set_wake_task(main_task_);

#if CONFIG_PM_ENABLE
    esp_pm_config_t power_management{};
    power_management.max_freq_mhz = 240;
    power_management.min_freq_mhz = 40;
    power_management.light_sleep_enable = true;
    if (esp_pm_configure(&power_management) != ESP_OK) return false;
    if (esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "display_awake", &display_awake_lock_) != ESP_OK ||
        esp_pm_lock_acquire(display_awake_lock_) != ESP_OK) {
        return false;
    }
    // The backlight flickers without this. M5GFX configures its LEDC timer with LEDC_AUTO_CLK, and on
    // ESP32-S3 the driver's clock-source search list starts with APB, so the PWM divisor is computed
    // once against an 80 MHz APB. Dynamic frequency scaling then moves APB with the CPU — min_freq is
    // 40 MHz — and the PWM frequency moves with it, which is visible as the backlight changing
    // brightness whenever the CPU idles down and back up. ESP-IDF's LEDC driver takes no PM lock of its
    // own, so the display owner has to pin APB for as long as the panel is lit.
    if (esp_pm_lock_create(ESP_PM_APB_FREQ_MAX, 0, "display_apb", &display_apb_lock_) != ESP_OK ||
        esp_pm_lock_acquire(display_apb_lock_) != ESP_OK) {
        return false;
    }
    display_awake_lock_held_ = true;
    display_apb_lock_held_ = true;
#else
    // Power management is compiled out in the debug profile: without light sleep and frequency scaling
    // the USB-Serial/JTAG peripheral stays enumerated, so the device does not vanish from the host
    // between a build and a flash. It costs battery life, which is exactly why it is not the shipping
    // configuration.
    ESP_LOGW(kTag, "Built without power management: light sleep and frequency scaling are off");
#endif

    image_pending_verification_ = FirmwareOta::pending_verification();
    transport_events_ = xEventGroupCreate();
    if (transport_events_ == nullptr || !wifi_.begin()) return false;

    const bool configured = settings_store_.load(settings_);
    if (!configured && !configure_device()) return false;

    hosty::ValidatedEndpoint endpoint;
    if (hosty::validate_core_origin(settings_.core_origin.view(), endpoint) != hosty::EndpointError::None) {
        show_overlay("Invalid Core origin", "Open setup and enter HTTPS,\nor local-network HTTP.");
        render();
        vTaskDelay(pdMS_TO_TICKS(2'000));
        if (!configure_device()) return false;
    }

    power_.set_policy(settings_.power);
    sync_ui_settings();
    ui_.device_label.assign_truncated(settings_.device_label.view());
    ui_.endpoint.assign_truncated(settings_.core_origin.view());
    const esp_app_desc_t* description = esp_app_get_description();
    ui_.firmware_version.assign_truncated(description == nullptr ? "unknown" : description->version);
    if (!client_.configure(settings_.core_origin.view(), settings_.access_token.view())) return false;
    state_.apply({hosty::ConnectionEvent::Type::Configured, now_ms()});
    return true;
}

bool FirmwareApp::configure_device() {
    hardware_.display_on();
    const hosty::FixedString<192> previous_origin = settings_.core_origin;
    hosty::FixedString<192> value;
    if (!prompt("2.4 GHz Wi-Fi SSID", settings_.wifi_ssid.view(), 32, false, value) || value.empty() ||
        !settings_.wifi_ssid.assign(value.view())) return false;
    if (!prompt("Wi-Fi password", settings_.wifi_password.view(), 63, true, value) ||
        !settings_.wifi_password.assign(value.view())) return false;

    while (true) {
        if (!prompt("Hosty Core origin", settings_.core_origin.view(), 192, false, value)) return false;
        hosty::ValidatedEndpoint endpoint;
        const hosty::EndpointError error = hosty::validate_core_origin(value.view(), endpoint);
        if (error == hosty::EndpointError::None) {
            // A token is only ever valid for the host that approved it, so it is dropped in the same
            // statement that changes the host — not at the end of the wizard. Every prompt below can
            // return early (cancelled, empty, or too long), and a clear placed after them leaves the
            // running firmware holding the new origin next to the previous host's credential.
            if (previous_origin.view() != endpoint.origin.view()) settings_.access_token.clear();
            settings_.core_origin.assign_truncated(endpoint.origin.view());
            break;
        }
        char message[96];
        std::snprintf(message, sizeof(message), "%s\nHTTPS anywhere; HTTP only on LAN", hosty::endpoint_error_name(error));
        show_overlay("Origin rejected", message);
        render();
        vTaskDelay(pdMS_TO_TICKS(1'500));
    }
    if (!prompt("POSIX time zone", settings_.time_zone.view(), 64, false, value) || value.empty() ||
        !settings_.time_zone.assign(value.view())) return false;
    if (!prompt("Device label", settings_.device_label.view(), 64, false, value) || value.empty() ||
        !settings_.device_label.assign(value.view())) return false;
    if (!settings_store_.save(settings_)) {
        show_overlay("Storage error", "Settings were not saved");
        render();
        vTaskDelay(pdMS_TO_TICKS(1'500));
        return false;
    }
    close_overlay();
    return true;
}

bool FirmwareApp::prompt(std::string_view label, std::string_view initial, std::size_t maximum,
                         bool secret, hosty::FixedString<192>& output) {
    output.clear();
    if (!output.assign(initial)) return false;
    while (true) {
        hardware_.fill(hosty::colors::Background);
        hardware_.fill_rect(0, 0, hardware_.width(), 19, hosty::colors::PanelRaised);
        hardware_.text(6, 6, "HOSTY DEVICE SETUP", hosty::colors::Text, hosty::colors::PanelRaised);
        hardware_.text(8, 31, label, hosty::colors::Muted, hosty::colors::Background);
        hardware_.fill_rect(7, 50, hardware_.width() - 14, 23, hosty::colors::Panel);
        if (secret) {
            char mask[35];
            const std::size_t visible = std::min<std::size_t>(output.size(), sizeof(mask) - 1);
            std::memset(mask, '*', visible);
            mask[visible] = '\0';
            hardware_.text(12, 58, mask, hosty::colors::Text, hosty::colors::Panel);
        } else {
            const auto visible = output.size() > 34 ? output.view().substr(output.size() - 34) : output.view();
            hardware_.text(12, 58, visible, hosty::colors::Text, hosty::colors::Panel);
        }
        hardware_.text(8, 88, "Enter accepts  |  Backspace edits", hosty::colors::Accent, hosty::colors::Background);
        hardware_.present();

        while (true) {
            hardware_.update();
            cardputer::KeyInput key;
            if (!hardware_.read_key(key)) {
                vTaskDelay(pdMS_TO_TICKS(15));
                continue;
            }
            if (key.code == cardputer::KeyCode::Enter) return true;
            if (key.code == cardputer::KeyCode::Escape) return false;
            if (key.code == cardputer::KeyCode::Backspace) output.pop_back();
            else if (key.code == cardputer::KeyCode::Character && output.size() < maximum) {
                static_cast<void>(output.append(key.character));
            }
            break;
        }
    }
}

bool FirmwareApp::connect_network() {
    state_.apply({hosty::ConnectionEvent::Type::Configured, now_ms()});
    render();
    if (!wifi_.connected() && !wifi_.connect(settings_, 20'000)) {
        state_.apply({hosty::ConnectionEvent::Type::WifiLost, now_ms()});
        set_status(wifi_.last_failure_message());
        return false;
    }
    state_.apply({hosty::ConnectionEvent::Type::WifiConnected, now_ms()});
    set_status("Wi-Fi connected; setting clock");
    return synchronize_clock();
}

bool FirmwareApp::synchronize_clock() {
    static_cast<void>(setenv("TZ", settings_.time_zone.c_str(), 1));
    tzset();
    hosty::ValidatedEndpoint endpoint;
    if (hosty::validate_core_origin(settings_.core_origin.view(), endpoint) != hosty::EndpointError::None) return false;

    if (!clock_meets_build_floor()) {
        esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
            3, ESP_SNTP_SERVER_LIST("pool.ntp.org", "time.cloudflare.com", "time.google.com"));
        const esp_err_t initialized = esp_netif_sntp_init(&config);
        if (initialized == ESP_OK || initialized == ESP_ERR_INVALID_STATE) {
            static_cast<void>(esp_netif_sntp_sync_wait(pdMS_TO_TICKS(5'000)));
        }
    }
    clock_ready_ = clock_meets_build_floor();
    if (clock_ready_) state_.apply({hosty::ConnectionEvent::Type::TimeReady, now_ms()});
    if (!clock_ready_ && endpoint.secure) {
        set_status("Setting time; retrying");
        return false;
    }
    if (!clock_ready_) set_status("Time unavailable; LAN only");
    return true;
}

bool FirmwareApp::authorize() {
    if (settings_.access_token.empty()) {
        hosty::Enrollment enrollment;
        enrollment.start(now_ms());
        hosty::DeviceCode code;
        const HttpResult code_result = client_.request_device_code(settings_.device_label.view(), code);
        if (!code_result.ok()) {
            set_request_failure("Device code", code_result);
            return false;
        }
        if (!enrollment.accept_code(code, now_ms())) {
            set_status("Device code response invalid");
            return false;
        }
        ESP_LOGI(kTag, "Device authorization code received");
        state_.apply({hosty::ConnectionEvent::Type::AuthorizationStarted, now_ms()});

        hosty::FixedString<512> instructions;
        static_cast<void>(instructions.append("Approve as host.admin\nCode: "));
        static_cast<void>(instructions.append(code.user_code.view()));
        static_cast<void>(instructions.append("\n"));
        static_cast<void>(instructions.append(code.verification_uri.view()));
        show_overlay("Authorize this device", instructions.view());
        render();

        while (enrollment.state() == hosty::EnrollmentState::WaitingForApproval) {
            hardware_.update();
            mark_image_healthy_when_ready();
            if (enrollment.poll_due(now_ms())) {
                hosty::DeviceTokenResult token;
                const HttpResult poll = client_.poll_device_token(code.device_code.view(), token);
                if (!poll.ok()) {
                    set_request_failure("Approval poll", poll);
                    return false;
                }
                enrollment.accept_token_result(token, now_ms());
            }
            if (enrollment.remaining_seconds(now_ms()) == 0) enrollment.mark_polled(now_ms());
            vTaskDelay(pdMS_TO_TICKS(25));
        }
        if (enrollment.state() != hosty::EnrollmentState::Approved) {
            set_status(enrollment.state() == hosty::EnrollmentState::Denied ? "Authorization denied" :
                       enrollment.state() == hosty::EnrollmentState::Expired ? "Authorization expired" :
                       "Authorization response invalid");
            return false;
        }
        if (!settings_.access_token.assign(enrollment.token().view()) || !settings_store_.save(settings_)) {
            set_status("Credential storage failed");
            return false;
        }
        ESP_LOGI(kTag, "Device authorization approved and stored");
        client_.set_access_token(settings_.access_token.view());
    }

    hosty::SessionInfo session;
    const HttpResult result = client_.read_session(session);
    if (!result.ok() || !session.authenticated) {
        if (!result.ok()) set_request_failure("Session", result);
        else set_status("Session not authenticated");
        if (result.unauthorized()) {
            static_cast<void>(settings_store_.clear_access_token());
            settings_.access_token.clear();
            client_.set_access_token({});
        }
        return false;
    }
    if (!session.administrator) {
        static_cast<void>(settings_store_.clear_access_token());
        settings_.access_token.clear();
        client_.set_access_token({});
        show_overlay("Administrator required", "Approved by host.user.\nApprove again as host.admin.");
        render();
        vTaskDelay(pdMS_TO_TICKS(3'000));
        return false;
    }
    close_overlay();
    state_.apply({hosty::ConnectionEvent::Type::Authorized, now_ms()});
    ESP_LOGI(kTag, "Authorized as host.admin");
    return true;
}

bool FirmwareApp::full_sync() {
    last_full_sync_ms_ = now_ms();
    state_.apply({hosty::ConnectionEvent::Type::SyncStarted, now_ms()});
    staging_core_ = {};
    std::string_view operation = "Core status";
    HttpResult result = client_.read_core_status(staging_core_);
    if (result.ok()) {
        operation = "Core update";
        result = client_.read_core_update_status(staging_core_);
    }
    if (result.ok()) {
        operation = "Apps";
        result = client_.read_apps(staging_core_);
    }
    if (!result.ok()) {
        set_request_failure(operation, result);
        state_.apply({result.unauthorized() ? hosty::ConnectionEvent::Type::Unauthorized
                                           : hosty::ConnectionEvent::Type::TransportFailed,
                      now_ms()});
        return false;
    }
    if (!hosty::version_at_least(staging_core_.version.view(), hosty::kMinimumCoreVersion)) {
        char message[48];
        std::snprintf(message, sizeof(message), "Core %s; need %.*s", staging_core_.version.c_str(),
                      static_cast<int>(hosty::kMinimumCoreVersion.size()), hosty::kMinimumCoreVersion.data());
        set_status(message);
        state_.apply({hosty::ConnectionEvent::Type::UnsupportedCore, now_ms()});
        return false;
    }
    staging_notifications_ = {};
    operation = "Notifications";
    result = client_.read_notifications(staging_notifications_);
    if (!result.ok()) {
        set_request_failure(operation, result);
        state_.apply({result.unauthorized() ? hosty::ConnectionEvent::Type::Unauthorized
                                           : hosty::ConnectionEvent::Type::TransportFailed,
                      now_ms()});
        return false;
    }
    state_.install_snapshot(staging_core_, now_ms());
    reapply_prediction();
    state_.install_notifications(staging_notifications_);
    last_unread_count_ = staging_notifications_.unread_count;
    state_.apply({hosty::ConnectionEvent::Type::SyncCompleted, now_ms()});
    image_health_eligible_ = true;
    ESP_LOGI(kTag, "Full synchronization completed with Core %s", staging_core_.version.c_str());
    return true;
}

void FirmwareApp::request_apps_sync() {
    apps_sync_pending_ = true;
    const bool command_requires_stable_apps =
        command_in_flight_ && pending_command_.action == PendingAction::UpdateAll;
    if (apps_sync_in_flight_ || command_requires_stable_apps || full_sync_pending_) return;

    apps_sync_pending_ = false;
    apps_sync_mode_ = SyncMode::Apps;
    staging_core_ = state_.core();
    apps_sync_result_ = {};
    apps_sync_operation_.assign_truncated("Apps");
    apps_sync_in_flight_ = true;
    if (xTaskCreate(&FirmwareApp::apps_sync_task_entry, "hosty_apps", kSyncStackBytes,
                    this, 4, nullptr) != pdPASS) {
        apps_sync_in_flight_ = false;
        apps_sync_pending_ = true;
        show_error("Unable to allocate app sync task");
        ESP_LOGE(kTag, "Unable to allocate app sync task heap-free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
    }
}

// A notification refresh is a network request like any other, so it runs on a worker rather than on
// the task that draws the screen and reads the keyboard. It used to be performed inline here, which
// meant a slow or unreachable Core froze the whole console for up to the 20-second request timeout —
// at exactly the moment an alert arrived and the operator was most likely to be looking at it.
void FirmwareApp::request_notifications_sync() {
    notifications_sync_pending_ = true;
    if (apps_sync_in_flight_ || command_in_flight_) return;

    notifications_sync_pending_ = false;
    staging_notifications_ = {};
    apps_sync_result_ = {};
    apps_sync_operation_.assign_truncated("Notifications");
    apps_sync_mode_ = SyncMode::Notifications;
    apps_sync_in_flight_ = true;
    if (xTaskCreate(&FirmwareApp::apps_sync_task_entry, "hosty_alerts", kSyncStackBytes,
                    this, 4, nullptr) != pdPASS) {
        apps_sync_in_flight_ = false;
        notifications_sync_pending_ = true;
        ESP_LOGE(kTag, "Unable to allocate notification sync task heap-free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
    }
}

void FirmwareApp::request_full_sync() {
    full_sync_pending_ = true;
    if (apps_sync_in_flight_ || command_in_flight_) return;

    full_sync_pending_ = false;
    apps_sync_pending_ = false;
    apps_sync_mode_ = SyncMode::Full;
    last_full_sync_ms_ = now_ms();
    staging_core_ = {};
    staging_notifications_ = {};
    apps_sync_result_ = {};
    apps_sync_operation_.assign_truncated("Core status");
    apps_sync_in_flight_ = true;
    if (xTaskCreate(&FirmwareApp::apps_sync_task_entry, "hosty_full_sync", kSyncStackBytes,
                    this, 4, nullptr) != pdPASS) {
        apps_sync_in_flight_ = false;
        full_sync_pending_ = true;
        show_error("Unable to allocate full sync task");
        ESP_LOGE(kTag, "Unable to allocate full sync task heap-free=%u largest=%u",
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
    }
}

void FirmwareApp::apps_sync_task() {
    if (apps_sync_mode_ == SyncMode::Notifications) {
        apps_sync_result_ = client_.read_notifications(staging_notifications_);
    } else if (apps_sync_mode_ == SyncMode::Full) {
        apps_sync_result_ = client_.read_core_status(staging_core_);
        if (apps_sync_result_.ok()) {
            apps_sync_operation_.assign_truncated("Core update");
            apps_sync_result_ = client_.read_core_update_status(staging_core_);
        }
        if (apps_sync_result_.ok()) {
            apps_sync_operation_.assign_truncated("Apps");
            apps_sync_result_ = client_.read_apps(staging_core_);
        }
        if (apps_sync_result_.ok()) {
            apps_sync_operation_.assign_truncated("Notifications");
            apps_sync_result_ = client_.read_notifications(staging_notifications_);
        }
    } else {
        apps_sync_result_ = client_.read_apps(staging_core_);
    }
    ESP_LOGI(kTag, "%s synchronization finished stack-free=%u bytes",
             apps_sync_mode_ == SyncMode::Full ? "Full"
                 : apps_sync_mode_ == SyncMode::Notifications ? "Notification" : "Apps",
             static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
    signal_transport(kAppsSyncFinished);
    vTaskDelete(nullptr);
}

void FirmwareApp::finish_apps_sync() {
    const HttpResult result = apps_sync_result_;
    const SyncMode mode = apps_sync_mode_;
    const bool full = mode == SyncMode::Full;
    apps_sync_in_flight_ = false;
    if (!result.ok()) {
        set_request_failure(apps_sync_operation_.view(), result);
        if (full) {
            state_.apply({result.unauthorized() ? hosty::ConnectionEvent::Type::Unauthorized
                                               : hosty::ConnectionEvent::Type::TransportFailed,
                          now_ms()});
            if (result.unauthorized()) signal_transport(kUnauthorized);
        }
    } else if (full && !hosty::version_at_least(staging_core_.version.view(), hosty::kMinimumCoreVersion)) {
        char message[48];
        std::snprintf(message, sizeof(message), "Core %s; need %.*s", staging_core_.version.c_str(),
                      static_cast<int>(hosty::kMinimumCoreVersion.size()), hosty::kMinimumCoreVersion.data());
        set_status(message);
        state_.apply({hosty::ConnectionEvent::Type::UnsupportedCore, now_ms()});
    } else if (mode == SyncMode::Notifications) {
        // Only the notification snapshot moved, so the app state and the connection's sync age are
        // left alone; ringing for a genuinely new alert is the one side effect.
        if (staging_notifications_.unread_count > last_unread_count_ && !staging_notifications_.items.empty()) {
            state_.install_notifications(staging_notifications_);
            apply_power_action(power_.notification(now_ms(), staging_notifications_.items[0].level, quiet_hours()));
        }
        last_unread_count_ = staging_notifications_.unread_count;
        state_.install_notifications(staging_notifications_);
        render_requested_ = true;
    } else {
        state_.install_snapshot(staging_core_, now_ms());
        reapply_prediction();
        if (full) {
            state_.install_notifications(staging_notifications_);
            last_unread_count_ = staging_notifications_.unread_count;
            last_full_sync_ms_ = now_ms();
            image_health_eligible_ = true;
        }
        state_.apply({hosty::ConnectionEvent::Type::SyncCompleted, now_ms()});
        render_requested_ = true;
    }

    if (command_waiting_for_sync_) {
        if (!start_command_task()) show_error("Unable to start Core operation");
    } else if (full_sync_pending_) {
        request_full_sync();
    } else if (apps_sync_pending_) {
        request_apps_sync();
    } else if (notifications_sync_pending_) {
        notifications_sync_pending_ = false;
        signal_transport(kSyncNotifications);
    }
}

bool FirmwareApp::sync_notifications(bool alert) {
    staging_notifications_ = {};
    const HttpResult result = client_.read_notifications(staging_notifications_);
    if (!result.ok()) {
        set_request_failure("Notifications", result);
        return false;
    }
    if (alert && staging_notifications_.unread_count > last_unread_count_ && !staging_notifications_.items.empty()) {
        const auto& notification = staging_notifications_.items[0];
        state_.install_notifications(staging_notifications_);
        apply_power_action(power_.notification(now_ms(), notification.level, quiet_hours()));
    }
    last_unread_count_ = staging_notifications_.unread_count;
    state_.install_notifications(staging_notifications_);
    render_requested_ = true;
    return true;
}

void FirmwareApp::main_loop() {
    while (true) {
        if (power_.mode() == hosty::PowerMode::Active) hardware_.update();
        handle_transport_events();

        cardputer::KeyInput key;
        const bool keyboard_activity = hardware_.keyboard_activity_pending() && hardware_.read_key(key);
        if (keyboard_activity) {
            handle_key(key);
            render_requested_ = true;
        }

        const std::uint64_t current = now_ms();
        if (power_.mode() == hosty::PowerMode::OnlineStandby && settings_.power.motion_wake &&
            current - last_motion_sample_ms_ >= kMotionStandbyIntervalMs) {
            last_motion_sample_ms_ = current;
            last_motion_delta_mg_ = hardware_.motion_delta_mg();
        } else {
            last_motion_delta_mg_ = 0;
        }
        apply_power_action(power_.tick(current, keyboard_activity, last_motion_delta_mg_));
        const hosty::PowerMode previous_power_mode = ui_.power_mode;
        ui_.power_mode = power_.mode();
        if (ui_.power_mode != previous_power_mode) render_requested_ = true;

        if (eco_sleeping_ && power_.mode() == hosty::PowerMode::Active) {
            resume_from_eco();
        } else if (eco_sleeping_ && current >= next_eco_poll_ms_) {
            poll_eco_notifications();
        }

        if (last_power_sample_ms_ == 0 || current - last_power_sample_ms_ >= 5'000) {
            last_power_sample_ms_ = current;
            const int battery_percent = hardware_.battery_percent();
            const bool charging = hardware_.charging();
            if (ui_.battery_percent != battery_percent || ui_.charging != charging) render_requested_ = true;
            ui_.battery_percent = battery_percent;
            ui_.charging = charging;
        }

        if (wifi_.connected() && current - last_full_sync_ms_ >= 60'000) request_full_sync();

        // The Home footer counts the snapshot's age in seconds, so it has to be redrawn while it is on
        // screen or it would freeze at whatever it last said — a stale age is worse than none, because
        // it reads as fresh. Only while Active and only on Dashboard: the frame hash still gates the
        // SPI push, so a second where nothing changed costs a redraw into RAM and no panel traffic.
        if (power_.mode() == hosty::PowerMode::Active && ui_.view == hosty::View::Dashboard &&
            !ui_.overlay_visible && current - last_age_tick_ms_ >= 1'000) {
            last_age_tick_ms_ = current;
            render_requested_ = true;
        }

        if (power_.mode() == hosty::PowerMode::Active && render_requested_) render();
        mark_image_healthy_when_ready();
        std::uint32_t wait_ms = power_.mode() == hosty::PowerMode::Active
            ? kActiveLoopIntervalMs
            : settings_.power.motion_wake ? kMotionStandbyIntervalMs : kIdleStandbyIntervalMs;
        if (eco_sleeping_ && !settings_.power.motion_wake) {
            const std::uint64_t current_after_work = now_ms();
            const std::uint64_t remaining = next_eco_poll_ms_ > current_after_work
                ? next_eco_poll_ms_ - current_after_work
                : 1;
            wait_ms = static_cast<std::uint32_t>(std::min<std::uint64_t>(remaining, settings_.eco_alert_interval_ms));
        }
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait_ms));
    }
}

void FirmwareApp::handle_key(const cardputer::KeyInput& key) {
    if (ui_.overlay_visible) {
        const char character = key.code == cardputer::KeyCode::Character ? lower_character(key.character) : 0;
        if (ui_.overlay_mode == hosty::OverlayMode::Menu) {
            if (key.code == cardputer::KeyCode::Escape || character == '`' || character == 'q') {
                close_overlay();
            } else if (key.code == cardputer::KeyCode::Up || character == ';') {
                move_menu_selection(-1);
            } else if (key.code == cardputer::KeyCode::Down || character == '.') {
                move_menu_selection(1);
            } else if (key.code == cardputer::KeyCode::Enter) {
                activate_menu_item();
            } else if (character != 0) {
                for (std::size_t index = 0; index < ui_.menu_items.size(); ++index) {
                    if (lower_character(ui_.menu_items[index].shortcut) == character) {
                        ui_.selected_menu_item = static_cast<std::uint8_t>(index);
                        activate_menu_item();
                        break;
                    }
                }
            }
            return;
        }
        // Enter over an alert clears the unread counter; Escape leaves it standing. Closing the
        // overlay is not the same act as acknowledging what it said.
        if (ui_.overlay_mode == hosty::OverlayMode::Alert && key.code == cardputer::KeyCode::Enter) {
            close_overlay();
            Confirmation mark;
            mark.action = PendingAction::MarkAlertsRead;
            if (!dispatch_command(mark)) show_error("Unable to start Core operation");
            return;
        }
        if (confirmation_.action == PendingAction::None) {
            if (key.code == cardputer::KeyCode::Escape || key.code == cardputer::KeyCode::Enter ||
                key.code == cardputer::KeyCode::Backspace || character == '`' || character == 'q') {
                close_overlay();
            }
            return;
        }
        if (key.code == cardputer::KeyCode::Escape ||
            (key.code == cardputer::KeyCode::Character &&
             (lower_character(key.character) == '`' || lower_character(key.character) == 'n'))) {
            confirmation_ = {};
            close_overlay();
            return;
        }
        const bool accepted = key.code == cardputer::KeyCode::Enter ||
            (confirmation_.presses_remaining == 1 && key.code == cardputer::KeyCode::Character &&
             lower_character(key.character) == 'y');
        if (accepted && confirmation_.presses_remaining > 0 && --confirmation_.presses_remaining == 0) {
            execute_confirmation();
        }
        return;
    }

    switch (key.code) {
        case cardputer::KeyCode::F1: ui_.view = hosty::View::Dashboard; return;
        case cardputer::KeyCode::F2: ui_.view = hosty::View::Apps; return;
        case cardputer::KeyCode::F3: ui_.view = hosty::View::Updates; return;
        case cardputer::KeyCode::F4: ui_.view = hosty::View::Device; return;
        case cardputer::KeyCode::Left: move_view(-1); return;
        case cardputer::KeyCode::Right: move_view(1); return;
        case cardputer::KeyCode::Up:
            if (ui_.view == hosty::View::Device) move_device_selection(-1);
            else if (ui_.view == hosty::View::Apps) move_selection(-1);
            return;
        case cardputer::KeyCode::Down:
            if (ui_.view == hosty::View::Device) move_device_selection(1);
            else if (ui_.view == hosty::View::Apps) move_selection(1);
            return;
        default: break;
    }

    if (key.code == cardputer::KeyCode::Enter) {
        if (ui_.view == hosty::View::Apps) open_context_menu(MenuContext::App);
        else if (ui_.view == hosty::View::Updates) open_context_menu(MenuContext::Updates);
        else if (ui_.view == hosty::View::Device) change_device_item();
        else if (!state_.notifications().items.empty()) {
            hosty::FixedString<512> alert;
            static_cast<void>(alert.append(state_.notifications().items[0].title.view()));
            static_cast<void>(alert.append("\n"));
            static_cast<void>(alert.append(state_.notifications().items[0].body.view()));
            show_overlay("Latest alert", alert.view());
            // Only offer to clear the counter when there is something unread to clear; re-reading an
            // already-read alert should not present an action that would do nothing.
            if (state_.notifications().unread_count > 0) ui_.overlay_mode = hosty::OverlayMode::Alert;
        }
        return;
    }
    if (key.code == cardputer::KeyCode::Delete && ui_.view == hosty::View::Device) {
        begin_confirmation(PendingAction::Revoke, "Revoke this credential?");
        return;
    }
    if (key.code != cardputer::KeyCode::Character) return;

    const char character = lower_character(key.character);
    if (character == ',' || character == '/') {
        move_view(character == ',' ? -1 : 1);
        return;
    }
    if (character == ';' || character == '.') {
        if (ui_.view == hosty::View::Device) move_device_selection(character == ';' ? -1 : 1);
        else if (ui_.view == hosty::View::Apps) move_selection(character == ';' ? -1 : 1);
        return;
    }
    if (ui_.view == hosty::View::Apps) execute_shortcut(MenuContext::App, character);
    else if (ui_.view == hosty::View::Updates) execute_shortcut(MenuContext::Updates, character);
    else if (ui_.view == hosty::View::Dashboard && character == 'u' &&
             state_.core().core_update.available) {
        execute_shortcut(MenuContext::Core, character);
    }
    else if (ui_.view == hosty::View::Device) {
        if (character == 'r' || character == 'u') execute_shortcut(MenuContext::Core, character);
        else if (character == 'o' || character == 'd' || character == 'x') {
            // The Device view forwards its shortcuts straight through, without opening the menu first.
            // Every action offered in that menu has to be listed here too, or the key does nothing at
            // all and looks like a dead button.
            execute_shortcut(MenuContext::Device, character);
        }
        else if (character == 'm') {
            ui_.selected_device = static_cast<std::uint8_t>(hosty::DeviceItem::MotionWake);
            change_device_item();
        } else if (character == 's') {
            ui_.selected_device = static_cast<std::uint8_t>(hosty::DeviceItem::Sound);
            change_device_item();
        } else if (character == 'q') {
            ui_.selected_device = static_cast<std::uint8_t>(hosty::DeviceItem::QuietHours);
            change_device_item();
        } else if (character == 't') {
            ui_.selected_device = static_cast<std::uint8_t>(hosty::DeviceItem::Theme);
            change_device_item();
        } else if (character == 'e') {
            ui_.selected_device = static_cast<std::uint8_t>(hosty::DeviceItem::StandbyMode);
            change_device_item();
        }
    }
}

void FirmwareApp::move_view(int delta) {
    constexpr int count = 4;
    const int current = static_cast<int>(ui_.view);
    ui_.view = static_cast<hosty::View>((current + delta + count) % count);
    render_requested_ = true;
}

void FirmwareApp::move_selection(int delta) {
    const auto size = state_.core().apps.size();
    if (size == 0) return;
    int selected = static_cast<int>(ui_.selected_app) + delta;
    selected = std::max(0, std::min(selected, static_cast<int>(size) - 1));
    ui_.selected_app = static_cast<std::uint16_t>(selected);
    if (ui_.selected_app < ui_.app_scroll) ui_.app_scroll = ui_.selected_app;
    if (ui_.selected_app >= ui_.app_scroll + 5) ui_.app_scroll = ui_.selected_app - 4;
}

void FirmwareApp::move_device_selection(int delta) {
    const int count = static_cast<int>(hosty::DeviceItem::Count);
    int selected = static_cast<int>(ui_.selected_device) + delta;
    selected = std::max(0, std::min(selected, count - 1));
    ui_.selected_device = static_cast<std::uint8_t>(selected);
    if (ui_.selected_device < ui_.device_scroll) ui_.device_scroll = ui_.selected_device;
    if (ui_.selected_device >= ui_.device_scroll + 5) ui_.device_scroll = ui_.selected_device - 4;
    render_requested_ = true;
}

void FirmwareApp::move_menu_selection(int delta) {
    if (ui_.menu_items.empty()) return;
    int selected = static_cast<int>(ui_.selected_menu_item) + delta;
    selected = std::max(0, std::min(selected, static_cast<int>(ui_.menu_items.size()) - 1));
    ui_.selected_menu_item = static_cast<std::uint8_t>(selected);
    if (ui_.selected_menu_item < ui_.menu_scroll) ui_.menu_scroll = ui_.selected_menu_item;
    if (ui_.selected_menu_item >= ui_.menu_scroll + 5) ui_.menu_scroll = ui_.selected_menu_item - 4;
    render_requested_ = true;
}

void FirmwareApp::open_context_menu(MenuContext context) {
    ui_.menu_items.clear();
    ui_.selected_menu_item = 0;
    ui_.menu_scroll = 0;
    menu_context_ = context;
    auto add = [this](char shortcut, std::string_view label) {
        hosty::MenuItem item;
        item.shortcut = shortcut;
        item.label.assign_truncated(label);
        static_cast<void>(ui_.menu_items.push_back(item));
    };

    if (context == MenuContext::App) {
        const hosty::AppSummary* app = selected_app();
        if (app == nullptr) {
            show_overlay("App actions", "No app is selected");
            return;
        }
        ui_.overlay_title.assign_truncated(app->display_name.view());
        if (!app->system && !hosty::is_busy(*app)) {
            add('S', hosty::is_running(*app) ? "Stop" : "Start");
            if (hosty::is_running(*app)) add('R', "Restart");
            add('A', app->autostart ? "Disable autostart" : "Enable autostart");
        }
        if (!hosty::is_busy(*app) && app->update.available && !app->update.requires_review &&
            !app->update.plan_digest.empty()) {
            add('U', "Apply update");
        }
    } else if (context == MenuContext::Updates) {
        ui_.overlay_title.assign_truncated("Update actions");
        add('C', "Check now");
        bool has_routine = false;
        for (const auto& app : state_.core().apps) {
            if (app.update.available && !app.update.requires_review && !app.update.plan_digest.empty() &&
                !hosty::is_busy(app)) {
                has_routine = true;
                break;
            }
        }
        if (has_routine) add('A', "Apply routine updates");
    } else if (context == MenuContext::Core) {
        ui_.overlay_title.assign_truncated("Core actions");
        add('R', "Restart Core");
        add('U', "Update Core");
    } else if (context == MenuContext::Device) {
        ui_.overlay_title.assign_truncated("Device actions");
        add('O', "Firmware update");
        add('D', "Deep standby");
        add('X', "Revoke credential");
    }

    if (ui_.menu_items.empty()) {
        show_overlay("No actions", "This item has no available actions");
        return;
    }
    ui_.overlay_body.clear();
    ui_.overlay_mode = hosty::OverlayMode::Menu;
    ui_.overlay_visible = true;
    render_requested_ = true;
}

void FirmwareApp::activate_menu_item() {
    if (ui_.selected_menu_item >= ui_.menu_items.size()) return;
    const char shortcut = lower_character(ui_.menu_items[ui_.selected_menu_item].shortcut);
    const MenuContext context = menu_context_;
    close_overlay();
    execute_shortcut(context, shortcut);
}

void FirmwareApp::execute_shortcut(MenuContext context, char shortcut) {
    const hosty::AppSummary* app = selected_app();
    if (context == MenuContext::App && app != nullptr) {
        if (!app->system && !hosty::is_busy(*app) && shortcut == 's') {
            begin_confirmation(hosty::is_running(*app) ? PendingAction::Stop : PendingAction::Start,
                               hosty::is_running(*app) ? "Stop selected app?" : "Start selected app?", app);
        } else if (!app->system && !hosty::is_busy(*app) && shortcut == 'r') {
            begin_confirmation(PendingAction::Restart, "Restart selected app?", app);
        } else if (!app->system && !hosty::is_busy(*app) && shortcut == 'a') {
            begin_confirmation(PendingAction::Autostart,
                               app->autostart ? "Disable autostart?" : "Enable autostart?", app);
        } else if (shortcut == 'u' && !hosty::is_busy(*app) && app->update.available &&
                   !app->update.requires_review && !app->update.plan_digest.empty()) {
            begin_confirmation(PendingAction::UpdateApp, "Apply routine update?", app);
        }
    } else if (context == MenuContext::Updates) {
        if (shortcut == 'c') {
            const HttpResult result = client_.start_update_check();
            if (!result.ok()) show_error("Update check failed");
            request_apps_sync();
        } else if (shortcut == 'a') {
            begin_confirmation(PendingAction::UpdateAll, "Apply all routine updates?");
        }
    } else if (context == MenuContext::Core) {
        if (shortcut == 'r') begin_confirmation(PendingAction::RestartCore, "Restart Core? Enter twice", nullptr, 2);
        else if (shortcut == 'u') begin_confirmation(PendingAction::UpdateCore, "Update Core? Enter twice", nullptr, 2);
    } else if (context == MenuContext::Device) {
        if (shortcut == 'o') begin_confirmation(PendingAction::FirmwareOta, "Firmware update? Enter twice", nullptr, 2);
        else if (shortcut == 'd') begin_confirmation(PendingAction::DeepStandby, "Enter deep standby?");
        else if (shortcut == 'x') begin_confirmation(PendingAction::Revoke, "Revoke this credential?");
    }
}

void FirmwareApp::change_device_item() {
    const auto item = static_cast<hosty::DeviceItem>(ui_.selected_device);
    bool save = true;
    switch (item) {
        case hosty::DeviceItem::StandbyMode:
            settings_.eco_standby = !settings_.eco_standby;
            break;
        case hosty::DeviceItem::ScreenTimeout: {
            const auto next = std::find_if(kDisplayTimeouts.begin(), kDisplayTimeouts.end(),
                                           [this](std::uint32_t value) { return value > settings_.power.display_timeout_ms; });
            settings_.power.display_timeout_ms = next == kDisplayTimeouts.end() ? kDisplayTimeouts.front() : *next;
            power_.set_policy(settings_.power);
            break;
        }
        case hosty::DeviceItem::AlertInterval: {
            const auto current = std::find(kEcoAlertIntervals.begin(), kEcoAlertIntervals.end(),
                                           settings_.eco_alert_interval_ms);
            settings_.eco_alert_interval_ms = current == kEcoAlertIntervals.end() || std::next(current) == kEcoAlertIntervals.end()
                ? kEcoAlertIntervals.front()
                : *std::next(current);
            break;
        }
        case hosty::DeviceItem::MotionWake:
            settings_.power.motion_wake = !settings_.power.motion_wake;
            if (settings_.power.motion_wake) {
                hardware_.reset_motion_reference();
                last_motion_sample_ms_ = 0;
            }
            power_.set_policy(settings_.power);
            break;
        case hosty::DeviceItem::Theme:
            settings_.theme = static_cast<hosty::ColorTheme>((static_cast<unsigned>(settings_.theme) + 1U) % 3U);
            break;
        case hosty::DeviceItem::Sound:
            settings_.sound_enabled = !settings_.sound_enabled;
            break;
        case hosty::DeviceItem::QuietHours:
            settings_.quiet_hours_enabled = !settings_.quiet_hours_enabled;
            break;
        case hosty::DeviceItem::Setup:
            save = false;
            if (configure_device()) esp_restart();
            break;
        case hosty::DeviceItem::CoreActions:
            save = false;
            open_context_menu(MenuContext::Core);
            break;
        case hosty::DeviceItem::DeviceActions:
            save = false;
            open_context_menu(MenuContext::Device);
            break;
        case hosty::DeviceItem::Count:
            save = false;
            break;
    }
    if (save) {
        sync_ui_settings();
        if (!settings_store_.save(settings_)) show_error("Settings were not saved");
        render_requested_ = true;
    }
}

void FirmwareApp::sync_ui_settings() {
    ui_.theme = settings_.theme;
    ui_.eco_standby = settings_.eco_standby;
    ui_.display_timeout_ms = settings_.power.display_timeout_ms;
    ui_.alert_interval_ms = settings_.eco_alert_interval_ms;
    ui_.motion_wake = settings_.power.motion_wake;
    ui_.sound_enabled = settings_.sound_enabled;
    ui_.quiet_hours_enabled = settings_.quiet_hours_enabled;
}

void FirmwareApp::begin_confirmation(PendingAction action, std::string_view title,
                                     const hosty::AppSummary* app, std::uint8_t presses) {
    if (command_in_flight_) {
        show_overlay("Operation in progress", "Wait for the current Core operation");
        return;
    }
    confirmation_ = {};
    confirmation_.action = action;
    confirmation_.presses_remaining = presses;
    if (app != nullptr) {
        confirmation_.app_id.assign_truncated(app->id.view());
        confirmation_.digest.assign_truncated(app->update.plan_digest.view());
        confirmation_.boolean_value = !app->autostart;
    }
    show_overlay(title, presses > 1 ? "Press Enter twice to confirm\nEsc cancels" : "Y or Enter confirms\nEsc cancels");
    ui_.overlay_mode = hosty::OverlayMode::Confirmation;
}

void FirmwareApp::execute_confirmation() {
    const Confirmation command = confirmation_;
    confirmation_ = {};
    close_overlay();
    if (command_in_flight_) {
        show_error("Operation already in progress");
        render();
        return;
    }
    if (command.action != PendingAction::Revoke && command.action != PendingAction::DeepStandby &&
        !mutation_allowed()) {
        show_error("Connect USB-C or charge above 15%");
        render();
        return;
    }
    render();

    if (command.action == PendingAction::FirmwareOta) {
        hosty::FixedString<96> detail;
        show_overlay("Firmware update", "Downloading over validated HTTPS...");
        render();
        const OtaResult ota_result = ota_.install(clock_ready_, hardware_.battery_percent(), hardware_.charging(), detail);
        if (ota_result == OtaResult::Installed) {
            show_overlay("Firmware installed", "Rebooting into the new OTA slot");
            render();
            vTaskDelay(pdMS_TO_TICKS(800));
            esp_restart();
        }
        close_overlay();
        show_error(detail.empty() ? ota_result_name(ota_result) : detail.view());
        return;
    }
    if (command.action == PendingAction::DeepStandby) {
        enter_deep_standby();
        return;
    }
    if (command.action == PendingAction::None) return;
    if (!dispatch_command(command)) {
        show_error("Unable to start Core operation");
        render_requested_ = true;
    }
}

bool FirmwareApp::dispatch_command(const Confirmation& command) {
    pending_command_ = command;
    command_result_ = {};
    command_in_flight_ = true;
    // Show the transition now. Core publishes `starting`/`stopping`, but seeing them costs a re-read of
    // /api/apps, and an app often finishes the transition before that round-trip completes — so the
    // operator would press the key and watch nothing change until the app was already running. The next
    // snapshot overwrites this prediction either way, so a refused or failed operation self-corrects.
    switch (command.action) {
        case PendingAction::Start:
        case PendingAction::Restart:
            predicted_state_ = hosty::RuntimeState::Starting;
            predicted_app_id_.assign_truncated(command.app_id.view());
            render_requested_ |= state_.predict_runtime_state(command.app_id.view(), predicted_state_);
            break;
        case PendingAction::Stop:
            predicted_state_ = hosty::RuntimeState::Stopping;
            predicted_app_id_.assign_truncated(command.app_id.view());
            render_requested_ |= state_.predict_runtime_state(command.app_id.view(), predicted_state_);
            break;
        default:
            break;
    }
    if (apps_sync_in_flight_) {
        command_waiting_for_sync_ = true;
        return true;
    }
    return start_command_task();
}

bool FirmwareApp::start_command_task() {
    command_waiting_for_sync_ = false;
    if (xTaskCreate(&FirmwareApp::command_task_entry, "hosty_command", kCommandStackBytes,
                    this, 4, nullptr) == pdPASS) {
        return true;
    }
    command_in_flight_ = false;
    pending_command_ = {};
    ESP_LOGE(kTag, "Unable to allocate command task heap-free=%u largest=%u",
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
             static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
    return false;
}

void FirmwareApp::command_task() {
    const Confirmation command = pending_command_;
    HttpResult result;
    result.status_code = 204;
    switch (command.action) {
        case PendingAction::Start: result = client_.app_lifecycle(command.app_id.view(), "start"); break;
        case PendingAction::Stop: result = client_.app_lifecycle(command.app_id.view(), "stop"); break;
        case PendingAction::Restart: result = client_.app_lifecycle(command.app_id.view(), "restart"); break;
        case PendingAction::Autostart:
            result = client_.set_autostart(command.app_id.view(), command.boolean_value);
            break;
        case PendingAction::UpdateApp:
            result = client_.apply_routine_update(command.app_id.view(), command.digest.view());
            break;
        case PendingAction::UpdateAll:
            for (const auto& app : state_.core().apps) {
                if (!app.update.available || app.update.requires_review || app.update.plan_digest.empty() ||
                    hosty::is_busy(app)) continue;
                const HttpResult update = client_.apply_routine_update(app.id.view(), app.update.plan_digest.view());
                if (!update.ok() && result.ok()) result = update;
            }
            break;
        case PendingAction::RestartCore: result = client_.restart_core(); break;
        case PendingAction::UpdateCore: result = client_.update_core(); break;
        case PendingAction::Revoke: result = client_.logout(); break;
        case PendingAction::MarkAlertsRead: result = client_.mark_notifications_read(); break;
        case PendingAction::FirmwareOta:
        case PendingAction::DeepStandby:
        case PendingAction::None: result.transport_error = ESP_ERR_INVALID_ARG; break;
    }
    command_result_ = result;
    ESP_LOGI(kTag, "Core operation finished action=%u stack-free=%u bytes",
             static_cast<unsigned>(command.action),
             static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
    signal_transport(kCommandFinished);
    vTaskDelete(nullptr);
}

void FirmwareApp::finish_command() {
    const Confirmation command = pending_command_;
    const HttpResult result = command_result_;
    pending_command_ = {};
    command_in_flight_ = false;
    command_waiting_for_sync_ = false;
    // The guess has served its purpose the moment Core has answered: from here the next snapshot is
    // authoritative, including when the operation was refused and the app never moved at all.
    predicted_app_id_.clear();
    predicted_state_ = hosty::RuntimeState::Unknown;

    if (command.action == PendingAction::Revoke) {
        if (!result.ok() && !result.unauthorized()) {
            show_error("Cannot revoke while Core is offline");
            return;
        }
        static_cast<void>(settings_store_.clear_access_token());
        settings_.access_token.clear();
        client_.set_access_token({});
        esp_restart();
    }
    if (!result.ok()) {
        if (result.unauthorized()) {
            signal_transport(kUnauthorized);
        } else {
            set_request_failure("Operation", result);
        }
        return;
    }

    if (command.action == PendingAction::MarkAlertsRead) {
        // Re-read notifications rather than assuming: the counter on screen has to come from Core, so
        // a mark that partially applied shows the truth instead of a hopeful zero.
        signal_transport(kSyncNotifications);
        return;
    }

    const bool app_related = command.action == PendingAction::Start || command.action == PendingAction::Stop ||
        command.action == PendingAction::Restart || command.action == PendingAction::Autostart ||
        command.action == PendingAction::UpdateApp || command.action == PendingAction::UpdateAll;
    if (full_sync_pending_) {
        request_full_sync();
    } else if (app_related) {
        request_apps_sync();
    } else if (notifications_sync_pending_) {
        notifications_sync_pending_ = false;
        signal_transport(kSyncNotifications);
    }
}

void FirmwareApp::show_overlay(std::string_view title, std::string_view body) {
    menu_context_ = MenuContext::None;
    ui_.menu_items.clear();
    ui_.overlay_title.assign_truncated(title);
    ui_.overlay_body.assign_truncated(body);
    ui_.overlay_mode = hosty::OverlayMode::Info;
    ui_.overlay_visible = true;
    render_requested_ = true;
}

void FirmwareApp::close_overlay() {
    ui_.overlay_visible = false;
    ui_.overlay_title.clear();
    ui_.overlay_body.clear();
    ui_.menu_items.clear();
    ui_.selected_menu_item = 0;
    ui_.menu_scroll = 0;
    ui_.overlay_mode = hosty::OverlayMode::Info;
    menu_context_ = MenuContext::None;
    render_requested_ = true;
}

// Re-assert the predicted lifecycle state over a snapshot that may predate the operator's key press.
//
// A sync already in flight when Start was pressed answers with the state from before the request ever
// reached Core, and install_snapshot replaces the whole snapshot — prediction included. That produced
// a visible stutter: "Starting", then back to "Stopped" as the stale read landed, then "Running" once
// the post-command sync arrived. Holding the prediction until the command finishes removes the
// backwards step without pretending to know the outcome.
void FirmwareApp::reapply_prediction() {
    if (!command_in_flight_ || predicted_app_id_.empty()) return;
    static_cast<void>(state_.predict_runtime_state(predicted_app_id_.view(), predicted_state_));
}



// Progress text for the boot and reconnect screens only; nothing in the steady-state UI renders it.
void FirmwareApp::set_status(std::string_view message) {
    ui_.status_message.assign_truncated(message);
    render_requested_ = true;
}

void FirmwareApp::set_request_failure(std::string_view operation, const HttpResult& result) {
    char message[64];
    if (result.transport_error != ESP_OK) {
        std::snprintf(message, sizeof(message), "%.*s: %s", static_cast<int>(operation.size()), operation.data(),
                      esp_err_to_name(result.transport_error));
    } else if (result.status_code < 200 || result.status_code >= 300) {
        std::snprintf(message, sizeof(message), "%.*s: HTTP %d", static_cast<int>(operation.size()), operation.data(),
                      result.status_code);
    } else {
        std::snprintf(message, sizeof(message), "%.*s: %s", static_cast<int>(operation.size()), operation.data(),
                      hosty::protocol_error_name(result.protocol_error));
    }
    ESP_LOGW(kTag, "%s", message);
    show_error(message);
}

// A failure the operator caused, shown where the operator is looking.
//
// The footer was the wrong home for this twice over: it is only drawn on Home, so a command issued
// from Apps reported its failure to a screen nobody was on, and it faded on its own, so a message
// missed was a message gone. An overlay appears over whichever view is current and stays until it is
// dismissed.
//
// Background failures deliberately do not come through here. A sync that fails because Wi-Fi blipped
// already moves the connection state, which the header and the Home age line report between them;
// interrupting the operator for it would be noise they did not ask for.
void FirmwareApp::show_error(std::string_view detail) {
    show_overlay("Operation failed", detail);
}

void FirmwareApp::render() {
    ui_.power_mode = power_.mode();
    // The Home footer reports how old the snapshot is, so the renderer needs the clock the rest of the
    // app runs on rather than one of its own.
    ui_.now_ms = now_ms();
    renderer_.render(hardware_, state_, ui_);
    render_requested_ = false;
}

void FirmwareApp::apply_power_action(const hosty::PowerAction& action) {
    if (action.display_on) {
        ESP_LOGI(kTag, "Display waking reason=%s motion_delta_mg=%u", wake_reason_name(action.wake_reason),
                 static_cast<unsigned>(last_motion_delta_mg_));
        if (display_awake_lock_ != nullptr && !display_awake_lock_held_ &&
            esp_pm_lock_acquire(display_awake_lock_) == ESP_OK) {
            display_awake_lock_held_ = true;
        }
        // Pinned together with the sleep lock: a lit panel needs a stable APB or its backlight PWM
        // drifts with the CPU frequency (see the lock's creation).
        if (display_apb_lock_ != nullptr && !display_apb_lock_held_ &&
            esp_pm_lock_acquire(display_apb_lock_) == ESP_OK) {
            display_apb_lock_held_ = true;
        }
        hardware_.display_on();
        render_requested_ = true;
    }
    if (action.display_off) {
        ESP_LOGI(kTag, "Display entering %s standby", settings_.eco_standby ? "Eco" : "live");
        hardware_.display_off();
        if (display_awake_lock_ != nullptr && display_awake_lock_held_ &&
            esp_pm_lock_release(display_awake_lock_) == ESP_OK) {
            display_awake_lock_held_ = false;
        }
        // Released with the panel, so standby — the mode the runtime target is measured in — keeps the
        // full frequency-scaling range.
        if (display_apb_lock_ != nullptr && display_apb_lock_held_ &&
            esp_pm_lock_release(display_apb_lock_) == ESP_OK) {
            display_apb_lock_held_ = false;
        }
        if (settings_.eco_standby) enter_eco_standby();
    }
    if (action.play_sound && settings_.sound_enabled &&
        (last_sound_ms_ == 0 || now_ms() - last_sound_ms_ >= 10'000)) {
        const auto& notifications = state_.notifications();
        hardware_.play_notification(notifications.items.empty() ? hosty::NotificationLevel::Info
                                                                 : notifications.items[0].level);
        last_sound_ms_ = now_ms();
    }
    if (action.enter_deep_sleep) enter_deep_standby();
}

void FirmwareApp::enter_eco_standby() {
    if (eco_sleeping_) return;
    eco_sleeping_ = true;
    stream_suspended_.store(true);
    next_eco_poll_ms_ = now_ms() + settings_.eco_alert_interval_ms;
    state_.apply({hosty::ConnectionEvent::Type::TransportFailed, now_ms()});
    wifi_.disconnect();
    ESP_LOGI(kTag, "Eco standby: radio off, next alert check in %u ms",
             static_cast<unsigned>(settings_.eco_alert_interval_ms));
}

void FirmwareApp::resume_from_eco() {
    if (!eco_sleeping_) return;
    eco_sleeping_ = false;
    ESP_LOGI(kTag, "Leaving Eco standby");
    const bool connected = connect_network();
    const bool authorized = connected && authorize();
    if (authorized) {
        static_cast<void>(full_sync());
    } else {
        set_status("Reconnect pending");
    }
    stream_suspended_.store(false);
    if (sse_task_handle_ != nullptr) xTaskNotifyGive(sse_task_handle_);
    render_requested_ = true;
}

void FirmwareApp::poll_eco_notifications() {
    if (!eco_sleeping_) return;
    next_eco_poll_ms_ = now_ms() + settings_.eco_alert_interval_ms;
    ESP_LOGI(kTag, "Eco standby alert check");
    if (!wifi_.connect(settings_, 20'000)) {
        ESP_LOGW(kTag, "Eco alert check skipped: %s", wifi_.last_failure_message());
        wifi_.disconnect();
        return;
    }
    static_cast<void>(sync_notifications(true));
    if (power_.mode() == hosty::PowerMode::Active) {
        resume_from_eco();
        return;
    }
    wifi_.disconnect();
}

void FirmwareApp::enter_deep_standby() {
    hardware_.display_off();
    wifi_.disconnect();
    gpio_config_t keyboard{};
    keyboard.pin_bit_mask = 1ULL << static_cast<unsigned>(kKeyboardInterruptPin);
    keyboard.mode = GPIO_MODE_INPUT;
    keyboard.pull_up_en = GPIO_PULLUP_ENABLE;
    keyboard.intr_type = GPIO_INTR_DISABLE;
    static_cast<void>(gpio_config(&keyboard));
    static_cast<void>(esp_sleep_enable_ext1_wakeup_io(1ULL << static_cast<unsigned>(kKeyboardInterruptPin),
                                                      ESP_EXT1_WAKEUP_ANY_LOW));
    static_cast<void>(esp_sleep_enable_timer_wakeup(60ULL * 60ULL * 1'000'000ULL));
    esp_deep_sleep_start();
}

void FirmwareApp::signal_transport(EventBits_t bits) {
    xEventGroupSetBits(transport_events_, bits);
    if (main_task_ != nullptr) xTaskNotifyGive(main_task_);
}

void FirmwareApp::handle_transport_events() {
    const EventBits_t events = xEventGroupClearBits(transport_events_, kAllTransportEvents);
    if ((events & kCommandFinished) != 0) finish_command();
    if ((events & kAppsSyncFinished) != 0) finish_apps_sync();
    if ((events & kUnauthorized) != 0) {
        state_.apply({hosty::ConnectionEvent::Type::Unauthorized, now_ms()});
        static_cast<void>(settings_store_.clear_access_token());
        settings_.access_token.clear();
        client_.set_access_token({});
        show_overlay("Authorization revoked", "Network settings are retained.\nApprove a new device code.");
        render();
        vTaskDelay(pdMS_TO_TICKS(2'000));
        close_overlay();
        while (!authorize()) vTaskDelay(pdMS_TO_TICKS(2'000));
        static_cast<void>(full_sync());
        return;
    }
    if ((events & kFullSync) != 0) request_full_sync();
    else {
        if ((events & kSyncApps) != 0) request_apps_sync();
        if ((events & kSyncNotifications) != 0) request_notifications_sync();
    }
    if ((events & kTransportFailed) != 0) {
        state_.apply({hosty::ConnectionEvent::Type::TransportFailed, now_ms()});
        render_requested_ = true;
    }
}

void FirmwareApp::mark_image_healthy_when_ready() {
    if (!image_pending_verification_) return;
    if (!image_health_eligible_ && now_ms() - boot_start_ms_ < 60'000) return;
    const esp_err_t result = FirmwareOta::mark_healthy();
    ESP_LOGI(kTag, "OTA health confirmation: %s", esp_err_to_name(result));
    image_pending_verification_ = false;
}

const hosty::AppSummary* FirmwareApp::selected_app() const {
    const auto& apps = state_.core().apps;
    return ui_.selected_app < apps.size() ? &apps[ui_.selected_app] : nullptr;
}

bool FirmwareApp::mutation_allowed() const {
    return hardware_.charging() || hardware_.battery_percent() < 0 || hardware_.battery_percent() >= 15;
}

bool FirmwareApp::quiet_hours() const {
    if (!settings_.quiet_hours_enabled || !clock_ready_) return false;
    const std::time_t current = std::time(nullptr);
    std::tm local{};
    localtime_r(&current, &local);
    const int start = settings_.quiet_start_hour;
    const int end = settings_.quiet_end_hour;
    return start == end || (start < end ? local.tm_hour >= start && local.tm_hour < end
                                       : local.tm_hour >= start || local.tm_hour < end);
}

std::uint64_t FirmwareApp::now_ms() const { return static_cast<std::uint64_t>(esp_timer_get_time() / 1000); }

bool FirmwareApp::on_sse_event(const hosty::SseEvent& event) {
    if (stream_suspended_.load()) return true;
    const hosty::SyncHint hint = state_.on_sse_event(event.name);
    ESP_LOGI(kTag, "SSE event=%.*s sync-hint=%u", static_cast<int>(event.name.size()), event.name.data(),
             static_cast<unsigned>(hint));
    if (hint == hosty::SyncHint::Apps) signal_transport(kSyncApps);
    else if (hint == hosty::SyncHint::Notifications) signal_transport(kSyncNotifications);
    else if (hint == hosty::SyncHint::Full) signal_transport(kFullSync);
    return true;
}

void FirmwareApp::on_stream_connected() {
    if (!stream_suspended_.load()) signal_transport(kFullSync);
}

void FirmwareApp::on_stream_closed(const HttpResult& result) {
    if (!stream_suspended_.load()) {
        signal_transport(result.unauthorized() ? kUnauthorized : kTransportFailed);
    }
}

void FirmwareApp::sse_task_entry(void* context) { static_cast<FirmwareApp*>(context)->sse_task(); }

void FirmwareApp::command_task_entry(void* context) { static_cast<FirmwareApp*>(context)->command_task(); }

void FirmwareApp::apps_sync_task_entry(void* context) { static_cast<FirmwareApp*>(context)->apps_sync_task(); }

void FirmwareApp::sse_task() {
    std::uint32_t delay_ms = 1'000;
    while (true) {
        if (stream_suspended_.load()) {
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            continue;
        }
        const std::uint64_t connected_at_ms = now_ms();
        const HttpResult result = client_.stream_events(*this);
        if (stream_suspended_.load()) continue;
        const std::uint64_t lifetime_ms = now_ms() - connected_at_ms;
        if (result.unauthorized() ||
            (result.status_code >= 200 && result.status_code < 300 && lifetime_ms >= kEventStreamHealthyLifetimeMs)) {
            delay_ms = 1'000;
        } else {
            delay_ms = std::min<std::uint32_t>(30'000, delay_ms * 2);
        }
        ESP_LOGW(kTag, "Event stream closed: transport=%s HTTP=%d lifetime=%llu ms; retry=%u ms; stack-free=%u bytes",
                 esp_err_to_name(result.transport_error), result.status_code,
                 static_cast<unsigned long long>(lifetime_ms), static_cast<unsigned>(delay_ms),
                 static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
}
