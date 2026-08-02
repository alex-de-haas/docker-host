#pragma once

#include "settings_store.hpp"

#include <esp_event.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>

#include <atomic>
#include <cstdint>

class WifiManager {
public:
    bool begin();
    bool connect(const DeviceSettings& settings, std::uint32_t timeout_ms);
    void disconnect();
    [[nodiscard]] bool connected() const;
    [[nodiscard]] const char* last_failure_message() const;

private:
    static void event_handler(void* context, esp_event_base_t base, std::int32_t id, void* data);

    EventGroupHandle_t events_ = nullptr;
    esp_event_handler_instance_t wifi_handler_ = nullptr;
    esp_event_handler_instance_t ip_handler_ = nullptr;
    std::atomic<std::uint8_t> last_disconnect_reason_{0};
    bool initialized_ = false;
    bool started_ = false;
    std::atomic_bool reconnect_enabled_{false};
};
