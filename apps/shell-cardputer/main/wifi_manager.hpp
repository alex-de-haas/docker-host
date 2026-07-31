#pragma once

#include "settings_store.hpp"

#include <esp_event.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>

class WifiManager {
public:
    bool begin();
    bool connect(const DeviceSettings& settings, std::uint32_t timeout_ms);
    void disconnect();
    [[nodiscard]] bool connected() const;

private:
    static void event_handler(void* context, esp_event_base_t base, std::int32_t id, void* data);

    EventGroupHandle_t events_ = nullptr;
    esp_event_handler_instance_t wifi_handler_ = nullptr;
    esp_event_handler_instance_t ip_handler_ = nullptr;
    bool initialized_ = false;
};
