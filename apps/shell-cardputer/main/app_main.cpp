#include "firmware_app.hpp"

#include <esp_log.h>
#include <nvs_flash.h>

namespace {

constexpr const char* kTag = "hosty_boot";

// The one place storage is initialized, and it happens before anything reads it. It used to live
// inside the application, which meant a reader earlier in the boot got a silent "nothing there"
// instead of an error.
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
    // Without storage the console cannot load its Wi-Fi credentials, cannot keep the token it is about
    // to be given, and would walk the operator through onboarding that silently fails to persist.
    // Refusing to start says so once; starting anyway would say it confusingly and repeatedly.
    if (!initialize_storage()) {
        ESP_LOGE(kTag, "NVS did not initialize; the console cannot run without storage");
        return;
    }

    static FirmwareApp application;
    application.run();
}
