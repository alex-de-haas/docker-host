#pragma once

#include "hosty/bounded.hpp"

#include <esp_err.h>

#include <cstdint>

enum class OtaResult : std::uint8_t {
    Installed,
    NoUpdate,
    ClockRequired,
    BatteryTooLow,
    DownloadFailed,
    InvalidImage,
};

class FirmwareOta {
public:
    static constexpr const char* kImageUrl =
        "https://github.com/alex-de-haas/docker-host/releases/download/cardputer-dev/hosty-cardputer.bin";

    OtaResult install(bool clock_ready, int battery_percent, bool charging,
                      hosty::FixedString<96>& detail) const;
    static bool pending_verification();
    static esp_err_t mark_healthy();
};

[[nodiscard]] const char* ota_result_name(OtaResult result);
