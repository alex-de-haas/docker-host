#include "firmware_app.hpp"

extern "C" void app_main() {
    static FirmwareApp application;
    application.run();
}
