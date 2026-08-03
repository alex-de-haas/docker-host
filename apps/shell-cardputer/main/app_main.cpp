#include "firmware_app.hpp"

#include <esp_log.h>
#include <nvs_flash.h>

namespace {

constexpr const char* kTag = "hosty_boot";

// Storage comes up before anything reads it. This used to live inside the application, which was fine
// until something earlier in the boot needed a stored value and silently got "nothing there".
bool initialize_storage() {
    esp_err_t error = nvs_flash_init();
    if (error == ESP_ERR_NVS_NO_FREE_PAGES || error == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        if (nvs_flash_erase() != ESP_OK) return false;
        error = nvs_flash_init();
    }
    return error == ESP_OK;
}

}  // namespace

extern "C" void app_main() {
    if (!initialize_storage()) {
        ESP_LOGE(kTag, "NVS did not initialize");
    }

    static FirmwareApp application;
    application.run();
}
