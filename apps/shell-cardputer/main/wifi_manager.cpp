#include "wifi_manager.hpp"

#include <esp_log.h>
#include <esp_netif.h>
#include <esp_wifi.h>

#include <algorithm>
#include <cstring>

namespace {

constexpr EventBits_t kConnected = BIT0;
constexpr EventBits_t kFailed = BIT1;
constexpr const char* kTag = "hosty_wifi";

}  // namespace

bool WifiManager::begin() {
    if (initialized_) return true;
    if (esp_netif_init() != ESP_OK) return false;
    const esp_err_t loop = esp_event_loop_create_default();
    if (loop != ESP_OK && loop != ESP_ERR_INVALID_STATE) return false;
    if (esp_netif_create_default_wifi_sta() == nullptr) return false;

    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&config) != ESP_OK) return false;
    events_ = xEventGroupCreate();
    if (events_ == nullptr) return false;
    if (esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &WifiManager::event_handler,
                                            this, &wifi_handler_) != ESP_OK ||
        esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &WifiManager::event_handler,
                                            this, &ip_handler_) != ESP_OK) {
        return false;
    }
    if (esp_wifi_set_mode(WIFI_MODE_STA) != ESP_OK || esp_wifi_set_ps(WIFI_PS_MIN_MODEM) != ESP_OK) return false;
    initialized_ = true;
    return true;
}

bool WifiManager::connect(const DeviceSettings& settings, std::uint32_t timeout_ms) {
    if (!initialized_ || settings.wifi_ssid.empty()) return false;
    xEventGroupClearBits(events_, kConnected | kFailed);

    wifi_config_t config{};
    const auto ssid_length = std::min(settings.wifi_ssid.size(), sizeof(config.sta.ssid) - 1);
    const auto password_length = std::min(settings.wifi_password.size(), sizeof(config.sta.password) - 1);
    std::memcpy(config.sta.ssid, settings.wifi_ssid.c_str(), ssid_length);
    std::memcpy(config.sta.password, settings.wifi_password.c_str(), password_length);
    config.sta.threshold.authmode = settings.wifi_password.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
    config.sta.pmf_cfg.capable = true;
    config.sta.pmf_cfg.required = false;

    if (esp_wifi_set_config(WIFI_IF_STA, &config) != ESP_OK) return false;
    const esp_err_t started = esp_wifi_start();
    if (started != ESP_OK && started != ESP_ERR_WIFI_CONN) return false;
    if (esp_wifi_connect() != ESP_OK) return false;

    const EventBits_t bits = xEventGroupWaitBits(events_, kConnected | kFailed, pdFALSE, pdFALSE,
                                                 pdMS_TO_TICKS(timeout_ms));
    return (bits & kConnected) != 0;
}

void WifiManager::disconnect() {
    if (!initialized_) return;
    static_cast<void>(esp_wifi_disconnect());
    static_cast<void>(esp_wifi_stop());
    xEventGroupClearBits(events_, kConnected | kFailed);
}

bool WifiManager::connected() const {
    return events_ != nullptr && (xEventGroupGetBits(events_) & kConnected) != 0;
}

void WifiManager::event_handler(void* context, esp_event_base_t base, std::int32_t id, void*) {
    auto& manager = *static_cast<WifiManager*>(context);
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(manager.events_, kConnected);
        xEventGroupSetBits(manager.events_, kFailed);
        ESP_LOGW(kTag, "Wi-Fi disconnected");
        static_cast<void>(esp_wifi_connect());
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupClearBits(manager.events_, kFailed);
        xEventGroupSetBits(manager.events_, kConnected);
        ESP_LOGI(kTag, "Wi-Fi connected");
    }
}
