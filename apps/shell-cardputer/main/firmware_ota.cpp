#include "firmware_ota.hpp"

#include "hosty/semver.hpp"

#include <esp_app_desc.h>
#include <esp_crt_bundle.h>
#include <esp_https_ota.h>
#include <esp_log.h>
#include <esp_ota_ops.h>

#include <cstring>

namespace {

constexpr const char* kTag = "hosty_ota";

}  // namespace

OtaResult FirmwareOta::install(bool clock_ready, int battery_percent, bool charging,
                               hosty::FixedString<96>& detail) const {
    detail.clear();
    if (!clock_ready) {
        detail.assign_truncated("Set the clock before firmware OTA");
        return OtaResult::ClockRequired;
    }
    if (!charging && battery_percent >= 0 && battery_percent < 50) {
        detail.assign_truncated("Charge to 50% or connect USB-C");
        return OtaResult::BatteryTooLow;
    }

    esp_http_client_config_t http{};
    http.url = kImageUrl;
    http.crt_bundle_attach = esp_crt_bundle_attach;
    http.timeout_ms = 30'000;
    http.keep_alive_enable = true;

    esp_https_ota_config_t config{};
    config.http_config = &http;
    config.partial_http_download = true;
    config.max_http_request_size = 16 * 1024;

    esp_https_ota_handle_t handle = nullptr;
    esp_err_t error = esp_https_ota_begin(&config, &handle);
    if (error != ESP_OK) {
        detail.assign_truncated(esp_err_to_name(error));
        return OtaResult::DownloadFailed;
    }

    esp_app_desc_t candidate{};
    error = esp_https_ota_get_img_desc(handle, &candidate);
    if (error != ESP_OK) {
        static_cast<void>(esp_https_ota_abort(handle));
        detail.assign_truncated("Release is not an ESP-IDF image");
        return OtaResult::InvalidImage;
    }
    const esp_app_desc_t* current = esp_app_get_description();
    if (current == nullptr || !hosty::version_at_least(candidate.version, current->version)) {
        static_cast<void>(esp_https_ota_abort(handle));
        detail.assign_truncated("Release is older than installed firmware");
        return OtaResult::NoUpdate;
    }

    do {
        error = esp_https_ota_perform(handle);
    } while (error == ESP_ERR_HTTPS_OTA_IN_PROGRESS);
    if (error != ESP_OK || !esp_https_ota_is_complete_data_received(handle)) {
        static_cast<void>(esp_https_ota_abort(handle));
        detail.assign_truncated(error == ESP_OK ? "Firmware download was incomplete" : esp_err_to_name(error));
        return OtaResult::DownloadFailed;
    }
    error = esp_https_ota_finish(handle);
    if (error != ESP_OK) {
        detail.assign_truncated(esp_err_to_name(error));
        return OtaResult::InvalidImage;
    }
    ESP_LOGI(kTag, "Installed firmware %s; reboot required", candidate.version);
    detail.assign_truncated(candidate.version);
    return OtaResult::Installed;
}

bool FirmwareOta::pending_verification() {
    const esp_partition_t* partition = esp_ota_get_running_partition();
    esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
    return partition != nullptr && esp_ota_get_state_partition(partition, &state) == ESP_OK &&
           state == ESP_OTA_IMG_PENDING_VERIFY;
}

esp_err_t FirmwareOta::mark_healthy() { return esp_ota_mark_app_valid_cancel_rollback(); }

const char* ota_result_name(OtaResult result) {
    switch (result) {
        case OtaResult::Installed: return "installed";
        case OtaResult::NoUpdate: return "no_update";
        case OtaResult::ClockRequired: return "clock_required";
        case OtaResult::BatteryTooLow: return "battery_too_low";
        case OtaResult::DownloadFailed: return "download_failed";
        case OtaResult::InvalidImage: return "invalid_image";
    }
    return "unknown";
}
