#include "wifi_manager.hpp"

#include <esp_log.h>
#include <esp_netif.h>
#include <esp_wifi.h>

#include <algorithm>
#include <cstring>

namespace {

constexpr EventBits_t kConnected = BIT0;
constexpr EventBits_t kStarted = BIT1;
constexpr const char* kTag = "hosty_wifi";
constexpr std::uint32_t kDriverStartTimeoutMs = 5'000;

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
    reconnect_enabled_.store(true);
    if (connected()) return true;

    if (!started_) {
        xEventGroupClearBits(events_, kConnected | kStarted);
        last_disconnect_reason_.store(0);

        wifi_config_t config{};
        // The whole array, not one less: an SSID is up to 32 bytes and is not NUL-terminated here —
        // esp_wifi_set_config measures it with strnlen over the full field. Reserving a terminator made
        // a valid 32-character SSID unreachable even though setup accepts one.
        const auto ssid_length = std::min(settings.wifi_ssid.size(), sizeof(config.sta.ssid));
        const auto password_length = std::min(settings.wifi_password.size(), sizeof(config.sta.password) - 1);
        std::memcpy(config.sta.ssid, settings.wifi_ssid.c_str(), ssid_length);
        std::memcpy(config.sta.password, settings.wifi_password.c_str(), password_length);
        config.sta.threshold.authmode = settings.wifi_password.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
        config.sta.pmf_cfg.capable = true;
        config.sta.pmf_cfg.required = false;
        config.sta.failure_retry_cnt = 5;

        if (esp_wifi_set_config(WIFI_IF_STA, &config) != ESP_OK) return false;
        const esp_err_t start = esp_wifi_start();
        if (start != ESP_OK) {
            ESP_LOGE(kTag, "Unable to start Wi-Fi: %s", esp_err_to_name(start));
            return false;
        }
        started_ = true;
    }

    const EventBits_t ready = xEventGroupWaitBits(events_, kStarted, pdFALSE, pdFALSE,
                                                  pdMS_TO_TICKS(kDriverStartTimeoutMs));
    if ((ready & kStarted) == 0) {
        ESP_LOGW(kTag, "Wi-Fi driver did not report station readiness within %u ms",
                 static_cast<unsigned>(kDriverStartTimeoutMs));
        return false;
    }

    const esp_err_t connect = esp_wifi_connect();
    if (connect != ESP_OK && connect != ESP_ERR_WIFI_CONN) {
        ESP_LOGW(kTag, "Unable to start Wi-Fi connection attempt: %s", esp_err_to_name(connect));
        return false;
    }

    ESP_LOGI(kTag, "Waiting up to %u ms for Wi-Fi; last-disconnect-reason=%u",
             static_cast<unsigned>(timeout_ms),
             static_cast<unsigned>(last_disconnect_reason_.load()));
    const EventBits_t bits = xEventGroupWaitBits(events_, kConnected, pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));
    return (bits & kConnected) != 0;
}

void WifiManager::disconnect() {
    if (!initialized_) return;
    reconnect_enabled_.store(false);
    static_cast<void>(esp_wifi_disconnect());
    static_cast<void>(esp_wifi_stop());
    started_ = false;
    xEventGroupClearBits(events_, kConnected | kStarted);
}

bool WifiManager::connected() const {
    return events_ != nullptr && (xEventGroupGetBits(events_) & kConnected) != 0;
}

const char* WifiManager::last_failure_message() const {
    const std::uint8_t reason = last_disconnect_reason_.load();
    switch (reason) {
        case WIFI_REASON_NO_AP_FOUND:
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
        case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
            return "Wi-Fi network not found";
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
            return "Wi-Fi authentication failed";
        case WIFI_REASON_BEACON_TIMEOUT:
        case WIFI_REASON_ASSOC_FAIL:
        case WIFI_REASON_CONNECTION_FAIL:
        case WIFI_REASON_TIMEOUT:
            return "Wi-Fi connection timed out";
        default:
            return reason == 0 ? "Wi-Fi association timed out" : "Wi-Fi disconnected; retrying";
    }
}

void WifiManager::event_handler(void* context, esp_event_base_t base, std::int32_t id, void* data) {
    auto& manager = *static_cast<WifiManager*>(context);
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        xEventGroupSetBits(manager.events_, kStarted);
        ESP_LOGI(kTag, "Wi-Fi station ready");
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_STOP) {
        xEventGroupClearBits(manager.events_, kConnected | kStarted);
        ESP_LOGI(kTag, "Wi-Fi station stopped");
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(manager.events_, kConnected);
        const auto* disconnected = static_cast<const wifi_event_sta_disconnected_t*>(data);
        const std::uint8_t reason = disconnected == nullptr ? 0 : disconnected->reason;
        manager.last_disconnect_reason_.store(reason);
        const bool reconnect = manager.reconnect_enabled_.load();
        ESP_LOGW(kTag, "Wi-Fi disconnected reason=%u rssi=%d reconnect=%s",
                 static_cast<unsigned>(reason),
                 disconnected == nullptr ? 0 : static_cast<int>(disconnected->rssi),
                 reconnect ? "yes" : "no");
        if (reconnect && reason != WIFI_REASON_ROAMING) {
            const esp_err_t retry = esp_wifi_connect();
            if (retry != ESP_OK && retry != ESP_ERR_WIFI_CONN && retry != ESP_ERR_WIFI_NOT_STARTED) {
                ESP_LOGW(kTag, "Unable to schedule Wi-Fi reconnect: %s", esp_err_to_name(retry));
            }
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(manager.events_, kConnected);
        manager.last_disconnect_reason_.store(0);
        ESP_LOGI(kTag, "Wi-Fi connected");
    }
}
