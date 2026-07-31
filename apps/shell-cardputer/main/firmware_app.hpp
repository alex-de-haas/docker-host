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
        DeepStandby,
    };

    struct Confirmation {
        PendingAction action = PendingAction::None;
        hosty::FixedString<96> app_id;
        hosty::FixedString<96> digest;
        bool boolean_value = false;
        std::uint8_t presses_remaining = 0;
    };

    static void sse_task_entry(void* context);
    void sse_task();
    bool initialize();
    bool configure_device();
    bool prompt(std::string_view label, std::string_view initial, std::size_t maximum,
                bool secret, hosty::FixedString<192>& output);
    bool connect_network();
    bool synchronize_clock();
    bool authorize();
    bool full_sync();
    bool sync_apps();
    bool sync_notifications(bool alert);
    void main_loop();
    void handle_key(const cardputer::KeyInput& key);
    void move_selection(int delta);
    void begin_confirmation(PendingAction action, std::string_view title,
                            const hosty::AppSummary* app = nullptr, std::uint8_t presses = 1);
    void execute_confirmation();
    void show_logs(const hosty::AppSummary& app);
    void show_overlay(std::string_view title, std::string_view body);
    void close_overlay();
    void set_status(std::string_view message);
    void render();
    void apply_power_action(const hosty::PowerAction& action);
    void enter_deep_standby();
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
    EventGroupHandle_t transport_events_ = nullptr;
    std::uint64_t last_render_ms_ = 0;
    std::uint64_t last_motion_sample_ms_ = 0;
    std::uint64_t last_full_sync_ms_ = 0;
    std::uint64_t last_sound_ms_ = 0;
    std::uint64_t boot_start_ms_ = 0;
    std::uint32_t last_unread_count_ = 0;
    std::uint16_t last_motion_delta_mg_ = 0;
    bool clock_ready_ = false;
    bool image_pending_verification_ = false;
    bool image_health_eligible_ = false;
};
