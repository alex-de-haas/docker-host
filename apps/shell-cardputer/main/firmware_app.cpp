#include "firmware_app.hpp"

#include "hosty/endpoint.hpp"
#include "hosty/semver.hpp"

#include <driver/gpio.h>
#include <esp_app_desc.h>
#include <esp_log.h>
#include <esp_netif_sntp.h>
#include <esp_ota_ops.h>
#include <esp_pm.h>
#include <esp_sleep.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <nvs_flash.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

namespace {

constexpr const char* kTag = "hosty_firmware";
constexpr EventBits_t kSyncApps = BIT0;
constexpr EventBits_t kSyncNotifications = BIT1;
constexpr EventBits_t kFullSync = BIT2;
constexpr EventBits_t kTransportFailed = BIT3;
constexpr EventBits_t kUnauthorized = BIT4;
constexpr EventBits_t kAllTransportEvents =
    kSyncApps | kSyncNotifications | kFullSync | kTransportFailed | kUnauthorized;
constexpr gpio_num_t kKeyboardInterruptPin = GPIO_NUM_11;

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

}  // namespace

void FirmwareApp::run() {
    if (!initialize()) {
        ESP_LOGE(kTag, "Firmware initialization failed");
        return;
    }

    while (!connect_network()) {
        show_overlay("Network unavailable", "Check Wi-Fi/NTP, then Enter\nF4 edits device settings");
        render();
        while (true) {
            hardware_.update();
            cardputer::KeyInput key;
            if (hardware_.read_key(key)) {
                if (key.code == cardputer::KeyCode::F4) {
                    static_cast<void>(configure_device());
                    esp_restart();
                }
                if (key.code == cardputer::KeyCode::Enter) break;
            }
            vTaskDelay(pdMS_TO_TICKS(20));
        }
        close_overlay();
    }

    while (!authorize()) {
        set_status("Authorization retry");
        vTaskDelay(pdMS_TO_TICKS(2'000));
    }
    image_health_eligible_ = full_sync();
    mark_image_healthy_when_ready();

    xTaskCreate(&FirmwareApp::sse_task_entry, "hosty_sse", 8'192, this, 4, nullptr);
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

    esp_pm_config_t power_management{};
    power_management.max_freq_mhz = 240;
    power_management.min_freq_mhz = 40;
    power_management.light_sleep_enable = true;
    if (esp_pm_configure(&power_management) != ESP_OK) return false;

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
    if (previous_origin.view() != settings_.core_origin.view()) settings_.access_token.clear();
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
        return false;
    }
    state_.apply({hosty::ConnectionEvent::Type::WifiConnected, now_ms()});
    return synchronize_clock();
}

bool FirmwareApp::synchronize_clock() {
    static_cast<void>(setenv("TZ", settings_.time_zone.c_str(), 1));
    tzset();
    hosty::ValidatedEndpoint endpoint;
    if (hosty::validate_core_origin(settings_.core_origin.view(), endpoint) != hosty::EndpointError::None) return false;

    if (!clock_meets_build_floor()) {
        esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
        const esp_err_t initialized = esp_netif_sntp_init(&config);
        if (initialized == ESP_OK || initialized == ESP_ERR_INVALID_STATE) {
            static_cast<void>(esp_netif_sntp_sync_wait(pdMS_TO_TICKS(20'000)));
        }
    }
    clock_ready_ = clock_meets_build_floor();
    if (clock_ready_) state_.apply({hosty::ConnectionEvent::Type::TimeReady, now_ms()});
    if (!clock_ready_ && endpoint.secure) {
        show_overlay("Clock not set", "HTTPS is blocked.\nCheck NTP access and retry.");
        render();
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
        if (!code_result.ok() || !enrollment.accept_code(code, now_ms())) return false;
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
                if (!poll.ok()) return false;
                enrollment.accept_token_result(token, now_ms());
            }
            if (enrollment.remaining_seconds(now_ms()) == 0) enrollment.mark_polled(now_ms());
            vTaskDelay(pdMS_TO_TICKS(25));
        }
        if (enrollment.state() != hosty::EnrollmentState::Approved) return false;
        if (!settings_.access_token.assign(enrollment.token().view()) || !settings_store_.save(settings_)) return false;
        client_.set_access_token(settings_.access_token.view());
    }

    hosty::SessionInfo session;
    const HttpResult result = client_.read_session(session);
    if (!result.ok() || !session.authenticated) {
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
    return true;
}

bool FirmwareApp::full_sync() {
    last_full_sync_ms_ = now_ms();
    state_.apply({hosty::ConnectionEvent::Type::SyncStarted, now_ms()});
    staging_core_ = {};
    HttpResult result = client_.read_core_status(staging_core_);
    if (result.ok()) result = client_.read_core_update_status(staging_core_);
    if (result.ok()) result = client_.read_apps(staging_core_);
    if (!result.ok()) {
        state_.apply({result.unauthorized() ? hosty::ConnectionEvent::Type::Unauthorized
                                           : hosty::ConnectionEvent::Type::TransportFailed,
                      now_ms()});
        return false;
    }
    if (!hosty::version_at_least(staging_core_.version.view(), hosty::kMinimumCoreVersion)) {
        state_.apply({hosty::ConnectionEvent::Type::UnsupportedCore, now_ms()});
        return false;
    }
    staging_notifications_ = {};
    result = client_.read_notifications(staging_notifications_);
    if (!result.ok()) {
        state_.apply({result.unauthorized() ? hosty::ConnectionEvent::Type::Unauthorized
                                           : hosty::ConnectionEvent::Type::TransportFailed,
                      now_ms()});
        return false;
    }
    state_.install_snapshot(staging_core_, now_ms());
    state_.install_notifications(staging_notifications_);
    last_unread_count_ = staging_notifications_.unread_count;
    state_.apply({hosty::ConnectionEvent::Type::SyncCompleted, now_ms()});
    image_health_eligible_ = true;
    set_status("Synchronized");
    return true;
}

bool FirmwareApp::sync_apps() {
    staging_core_ = state_.core();
    const HttpResult result = client_.read_apps(staging_core_);
    if (!result.ok()) return false;
    state_.install_snapshot(staging_core_, now_ms());
    state_.apply({hosty::ConnectionEvent::Type::SyncCompleted, now_ms()});
    return true;
}

bool FirmwareApp::sync_notifications(bool alert) {
    staging_notifications_ = {};
    const HttpResult result = client_.read_notifications(staging_notifications_);
    if (!result.ok()) return false;
    if (alert && staging_notifications_.unread_count > last_unread_count_ && !staging_notifications_.items.empty()) {
        const auto& notification = staging_notifications_.items[0];
        state_.install_notifications(staging_notifications_);
        apply_power_action(power_.notification(now_ms(), notification.level, quiet_hours()));
        set_status(notification.title.view());
    }
    last_unread_count_ = staging_notifications_.unread_count;
    state_.install_notifications(staging_notifications_);
    return true;
}

void FirmwareApp::main_loop() {
    while (true) {
        hardware_.update();
        handle_transport_events();

        cardputer::KeyInput key;
        const bool keyboard_activity = hardware_.read_key(key);
        if (keyboard_activity) handle_key(key);

        const std::uint64_t current = now_ms();
        if (current - last_motion_sample_ms_ >= 250) {
            last_motion_sample_ms_ = current;
            last_motion_delta_mg_ = hardware_.motion_delta_mg();
        } else {
            last_motion_delta_mg_ = 0;
        }
        apply_power_action(power_.tick(current, keyboard_activity, last_motion_delta_mg_));
        ui_.power_mode = power_.mode();
        ui_.battery_percent = hardware_.battery_percent();
        ui_.charging = hardware_.charging();

        if (wifi_.connected() && current - last_full_sync_ms_ >= 60'000) {
            static_cast<void>(full_sync());
        }
        if (power_.mode() == hosty::PowerMode::Active && current - last_render_ms_ >= 200) render();
        mark_image_healthy_when_ready();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void FirmwareApp::handle_key(const cardputer::KeyInput& key) {
    if (ui_.overlay_visible) {
        if (confirmation_.action == PendingAction::None) {
            if (key.code == cardputer::KeyCode::Escape || key.code == cardputer::KeyCode::Enter) close_overlay();
            return;
        }
        if (key.code == cardputer::KeyCode::Escape ||
            (key.code == cardputer::KeyCode::Character && lower_character(key.character) == 'n')) {
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
        case cardputer::KeyCode::Up: move_selection(-1); return;
        case cardputer::KeyCode::Down: move_selection(1); return;
        default: break;
    }
    if (key.code == cardputer::KeyCode::Enter && ui_.view == hosty::View::Device) {
        if (configure_device()) esp_restart();
        return;
    }
    if (key.code == cardputer::KeyCode::Delete && ui_.view == hosty::View::Device) {
        begin_confirmation(PendingAction::Revoke, "Revoke this credential?");
        return;
    }
    if (key.code != cardputer::KeyCode::Character) return;

    const char character = lower_character(key.character);
    const hosty::AppSummary* app = selected_app();
    if (ui_.view == hosty::View::Apps && app != nullptr) {
        if (character == 'l' && app->logs_available) show_logs(*app);
        else if (!app->system && !hosty::is_busy(*app) && character == 's') {
            begin_confirmation(hosty::is_running(*app) ? PendingAction::Stop : PendingAction::Start,
                               hosty::is_running(*app) ? "Stop selected app?" : "Start selected app?", app);
        } else if (!app->system && !hosty::is_busy(*app) && character == 'r') {
            begin_confirmation(PendingAction::Restart, "Restart selected app?", app);
        } else if (!app->system && !hosty::is_busy(*app) && character == 'a') {
            begin_confirmation(PendingAction::Autostart, app->autostart ? "Disable autostart?" : "Enable autostart?", app);
        } else if (character == 'u' && app->update.available && !app->update.requires_review &&
                   !app->update.plan_digest.empty() && !hosty::is_busy(*app)) {
            begin_confirmation(PendingAction::UpdateApp, "Apply routine update?", app);
        }
    } else if (ui_.view == hosty::View::Updates) {
        if (character == 'c') begin_confirmation(PendingAction::None, "Checking for updates");
        else if (character == 'a') begin_confirmation(PendingAction::UpdateAll, "Apply all routine updates?");
        if (character == 'c') {
            close_overlay();
            const HttpResult result = client_.start_update_check();
            set_status(result.ok() ? "Update check started" : "Update check failed");
            static_cast<void>(sync_apps());
        }
    } else if (ui_.view == hosty::View::Device) {
        if (character == 'r') begin_confirmation(PendingAction::RestartCore, "Restart Core? Enter twice", nullptr, 2);
        else if (character == 'u') begin_confirmation(PendingAction::UpdateCore, "Update Core? Enter twice", nullptr, 2);
        else if (character == 'o') begin_confirmation(PendingAction::FirmwareOta, "Firmware OTA? Enter twice", nullptr, 2);
        else if (character == 'd') begin_confirmation(PendingAction::DeepStandby, "Enter deep standby?");
        else if (character == 'm') {
            settings_.power.motion_wake = !settings_.power.motion_wake;
            power_.set_policy(settings_.power);
            static_cast<void>(settings_store_.save(settings_));
            set_status(settings_.power.motion_wake ? "Motion wake enabled" : "Motion wake disabled");
        } else if (character == 's') {
            settings_.sound_enabled = !settings_.sound_enabled;
            static_cast<void>(settings_store_.save(settings_));
            set_status(settings_.sound_enabled ? "Sound enabled" : "Sound muted");
        } else if (character == 'q') {
            settings_.quiet_hours_enabled = !settings_.quiet_hours_enabled;
            static_cast<void>(settings_store_.save(settings_));
            set_status(settings_.quiet_hours_enabled ? "Quiet hours enabled" : "Quiet hours disabled");
        } else if (key.character == '+') {
            settings_.power.display_timeout_ms = std::min<std::uint32_t>(120'000, settings_.power.display_timeout_ms + 15'000);
            power_.set_policy(settings_.power);
            static_cast<void>(settings_store_.save(settings_));
            set_status("Display timeout increased");
        } else if (key.character == '-') {
            settings_.power.display_timeout_ms = std::max<std::uint32_t>(10'000, settings_.power.display_timeout_ms -
                                                                         std::min<std::uint32_t>(15'000, settings_.power.display_timeout_ms));
            power_.set_policy(settings_.power);
            static_cast<void>(settings_store_.save(settings_));
            set_status("Display timeout decreased");
        }
    }
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

void FirmwareApp::begin_confirmation(PendingAction action, std::string_view title,
                                     const hosty::AppSummary* app, std::uint8_t presses) {
    confirmation_ = {};
    confirmation_.action = action;
    confirmation_.presses_remaining = presses;
    if (app != nullptr) {
        confirmation_.app_id.assign_truncated(app->id.view());
        confirmation_.digest.assign_truncated(app->update.plan_digest.view());
        confirmation_.boolean_value = !app->autostart;
    }
    show_overlay(title, presses > 1 ? "Press Enter twice to confirm\nEsc cancels" : "Y or Enter confirms\nEsc cancels");
}

void FirmwareApp::execute_confirmation() {
    const Confirmation command = confirmation_;
    confirmation_ = {};
    close_overlay();
    if (command.action != PendingAction::Revoke && command.action != PendingAction::DeepStandby &&
        !mutation_allowed()) {
        set_status("Connect USB-C or charge above 15%");
        return;
    }

    HttpResult result;
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
        case PendingAction::UpdateAll: {
            bool all_ok = true;
            for (const auto& app : state_.core().apps) {
                if (!app.update.available || app.update.requires_review || app.update.plan_digest.empty() ||
                    hosty::is_busy(app)) continue;
                if (!client_.apply_routine_update(app.id.view(), app.update.plan_digest.view()).ok()) all_ok = false;
            }
            set_status(all_ok ? "Routine updates queued" : "Some updates failed");
            static_cast<void>(sync_apps());
            return;
        }
        case PendingAction::RestartCore: result = client_.restart_core(); break;
        case PendingAction::UpdateCore: result = client_.update_core(); break;
        case PendingAction::FirmwareOta: {
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
            set_status(detail.empty() ? ota_result_name(ota_result) : detail.view());
            return;
        }
        case PendingAction::Revoke:
            result = client_.logout();
            if (!result.ok() && !result.unauthorized()) {
                set_status("Cannot revoke while Core is offline");
                return;
            }
            static_cast<void>(settings_store_.clear_access_token());
            settings_.access_token.clear();
            client_.set_access_token({});
            esp_restart();
            return;
        case PendingAction::DeepStandby: enter_deep_standby(); return;
        case PendingAction::None: return;
    }
    set_status(result.ok() ? "Operation accepted" : result.unauthorized() ? "Authorization revoked" : "Operation failed");
    if (result.unauthorized()) xEventGroupSetBits(transport_events_, kUnauthorized);
    else static_cast<void>(sync_apps());
}

void FirmwareApp::show_logs(const hosty::AppSummary& app) {
    hosty::LogTail logs;
    const HttpResult result = client_.read_log_tail(app.id.view(), logs);
    show_overlay(app.display_name.view(), result.ok() ? logs.text.view() : "Log tail unavailable");
}

void FirmwareApp::show_overlay(std::string_view title, std::string_view body) {
    ui_.overlay_title.assign_truncated(title);
    ui_.overlay_body.assign_truncated(body);
    ui_.overlay_visible = true;
}

void FirmwareApp::close_overlay() {
    ui_.overlay_visible = false;
    ui_.overlay_title.clear();
    ui_.overlay_body.clear();
}

void FirmwareApp::set_status(std::string_view message) { ui_.status_message.assign_truncated(message); }

void FirmwareApp::render() {
    ui_.power_mode = power_.mode();
    ui_.battery_percent = hardware_.battery_percent();
    ui_.charging = hardware_.charging();
    renderer_.render(hardware_, state_, ui_);
    last_render_ms_ = now_ms();
}

void FirmwareApp::apply_power_action(const hosty::PowerAction& action) {
    if (action.display_on) hardware_.display_on();
    if (action.display_off) hardware_.display_off();
    if (action.play_sound && settings_.sound_enabled &&
        (last_sound_ms_ == 0 || now_ms() - last_sound_ms_ >= 10'000)) {
        const auto& notifications = state_.notifications();
        hardware_.play_notification(notifications.items.empty() ? hosty::NotificationLevel::Info
                                                                 : notifications.items[0].level);
        last_sound_ms_ = now_ms();
    }
    if (action.enter_deep_sleep) enter_deep_standby();
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

void FirmwareApp::handle_transport_events() {
    const EventBits_t events = xEventGroupClearBits(transport_events_, kAllTransportEvents);
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
    if ((events & kFullSync) != 0) static_cast<void>(full_sync());
    else {
        if ((events & kSyncApps) != 0) static_cast<void>(sync_apps());
        if ((events & kSyncNotifications) != 0) static_cast<void>(sync_notifications(true));
    }
    if ((events & kTransportFailed) != 0) {
        state_.apply({hosty::ConnectionEvent::Type::TransportFailed, now_ms()});
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
    const hosty::SyncHint hint = state_.on_sse_event(event.name);
    if (hint == hosty::SyncHint::Apps) xEventGroupSetBits(transport_events_, kSyncApps);
    else if (hint == hosty::SyncHint::Notifications) xEventGroupSetBits(transport_events_, kSyncNotifications);
    else if (hint == hosty::SyncHint::Full) xEventGroupSetBits(transport_events_, kFullSync);
    return true;
}

void FirmwareApp::on_stream_connected() { xEventGroupSetBits(transport_events_, kFullSync); }

void FirmwareApp::on_stream_closed(const HttpResult& result) {
    xEventGroupSetBits(transport_events_, result.unauthorized() ? kUnauthorized : kTransportFailed);
}

void FirmwareApp::sse_task_entry(void* context) { static_cast<FirmwareApp*>(context)->sse_task(); }

void FirmwareApp::sse_task() {
    std::uint32_t delay_ms = 1'000;
    while (true) {
        const HttpResult result = client_.stream_events(*this);
        if (result.status_code >= 200 && result.status_code < 300) delay_ms = 1'000;
        else delay_ms = std::min<std::uint32_t>(30'000, delay_ms * 2);
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
}
