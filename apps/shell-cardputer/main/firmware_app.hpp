#pragma once

#include "cardputer/cardputer_hardware.hpp"
#include "firmware_ota.hpp"
#include "hosty/auth.hpp"
#include "hosty/power.hpp"
#include "hosty/render.hpp"
#include "hosty/state.hpp"
#include "hosty_client.hpp"
#include "settings_store.hpp"
#include "wifi_manager.hpp"

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <esp_pm.h>

#include <atomic>
#include <cstdint>
#include <string_view>

class FirmwareApp final : public EventStreamObserver {
public:
    void run();

    bool on_sse_event(const hosty::SseEvent& event) override;
    void on_stream_connected() override;
    void on_stream_closed(const HttpResult& result) override;

private:
    enum class PendingAction : std::uint8_t {
        None,
        Start,
        Stop,
        Restart,
        Autostart,
        UpdateApp,
        UpdateAll,
        RestartCore,
        UpdateCore,
        FirmwareOta,
        Revoke,
        MarkAlertsRead,
        DeepStandby,
    };

    enum class MenuContext : std::uint8_t { None, App, Updates, Core, Device };

    // What the shared sync worker is fetching. Notifications run on it too, so an alert arriving while
    // Core is slow cannot block the task that draws the screen.
    enum class SyncMode : std::uint8_t { Apps, Full, Notifications };

    struct Confirmation {
        PendingAction action = PendingAction::None;
        hosty::FixedString<96> app_id;
        hosty::FixedString<96> digest;
        bool boolean_value = false;
        std::uint8_t presses_remaining = 0;
    };

    static void sse_task_entry(void* context);
    static void command_task_entry(void* context);
    static void apps_sync_task_entry(void* context);
    void sse_task();
    void command_task();
    void apps_sync_task();
    bool initialize();
    bool configure_device();
    bool prompt(std::string_view label, std::string_view initial, std::size_t maximum,
                bool secret, hosty::FixedString<192>& output);
    bool connect_network();
    bool synchronize_clock();
    bool authorize();
    bool full_sync();
    bool sync_notifications(bool alert);
    void main_loop();
    void handle_key(const cardputer::KeyInput& key);
    void move_view(int delta);
    void move_selection(int delta);
    void move_device_selection(int delta);
    void move_menu_selection(int delta);
    void open_context_menu(MenuContext context);
    void activate_menu_item();
    void execute_shortcut(MenuContext context, char shortcut);
    void change_device_item();
    void sync_ui_settings();
    void begin_confirmation(PendingAction action, std::string_view title,
                            const hosty::AppSummary* app = nullptr, std::uint8_t presses = 1);
    void execute_confirmation();
    bool dispatch_command(const Confirmation& command);
    bool start_command_task();
    void finish_command();
    void request_apps_sync();
    void request_notifications_sync();
    void request_full_sync();
    void finish_apps_sync();
    void show_overlay(std::string_view title, std::string_view body);
    void close_overlay();
    void reapply_prediction();
    void set_status(std::string_view message);
    void show_error(std::string_view detail);
    void set_request_failure(std::string_view operation, const HttpResult& result);
    void render();
    void apply_power_action(const hosty::PowerAction& action);
    void enter_eco_standby();
    void resume_from_eco();
    void poll_eco_notifications();
    void enter_deep_standby();
    void signal_transport(EventBits_t bits);
    void handle_transport_events();
    void mark_image_healthy_when_ready();
    [[nodiscard]] const hosty::AppSummary* selected_app() const;
    [[nodiscard]] bool mutation_allowed() const;
    [[nodiscard]] bool quiet_hours() const;
    [[nodiscard]] std::uint64_t now_ms() const;

    cardputer::CardputerHardware hardware_;
    SettingsStore settings_store_;
    DeviceSettings settings_;
    WifiManager wifi_;
    HostyClient client_;
    FirmwareOta ota_;
    hosty::ClientState state_;
    hosty::CoreSnapshot staging_core_;
    hosty::NotificationSnapshot staging_notifications_;
    hosty::UiState ui_;
    hosty::Renderer renderer_;
    hosty::PowerController power_;
    Confirmation confirmation_;
    Confirmation pending_command_;
    MenuContext menu_context_ = MenuContext::None;
    HttpResult command_result_;
    HttpResult apps_sync_result_;
    hosty::FixedString<24> apps_sync_operation_;
    // Lifecycle state shown for predicted_app_id_ until its command completes; see reapply_prediction().
    hosty::FixedString<96> predicted_app_id_;
    hosty::RuntimeState predicted_state_ = hosty::RuntimeState::Unknown;
    EventGroupHandle_t transport_events_ = nullptr;
    TaskHandle_t main_task_ = nullptr;
    TaskHandle_t sse_task_handle_ = nullptr;
    esp_pm_lock_handle_t display_awake_lock_ = nullptr;
    esp_pm_lock_handle_t display_apb_lock_ = nullptr;
    std::uint64_t last_motion_sample_ms_ = 0;
    std::uint64_t last_power_sample_ms_ = 0;
    std::uint64_t last_age_tick_ms_ = 0;
    std::uint64_t last_full_sync_ms_ = 0;
    std::uint64_t last_sound_ms_ = 0;
    std::uint64_t boot_start_ms_ = 0;
    std::uint64_t next_eco_poll_ms_ = 0;
    std::uint32_t last_unread_count_ = 0;
    std::uint16_t last_motion_delta_mg_ = 0;
    bool clock_ready_ = false;
    std::atomic_bool stream_suspended_{false};
    bool image_pending_verification_ = false;
    bool image_health_eligible_ = false;
    bool display_awake_lock_held_ = false;
    bool display_apb_lock_held_ = false;
    bool command_in_flight_ = false;
    bool command_waiting_for_sync_ = false;
    bool apps_sync_in_flight_ = false;
    bool apps_sync_pending_ = false;
    SyncMode apps_sync_mode_ = SyncMode::Apps;
    bool full_sync_pending_ = false;
    bool notifications_sync_pending_ = false;
    bool eco_sleeping_ = false;
    bool render_requested_ = true;
};
