#pragma once

#include "hosty/bounded.hpp"
#include "hosty/power.hpp"

#include <cstdint>

struct DeviceSettings {
    hosty::FixedString<32> wifi_ssid;
    hosty::FixedString<64> wifi_password;
    hosty::FixedString<192> core_origin;
    hosty::FixedString<64> time_zone{"UTC0"};
    hosty::FixedString<64> device_label{"Hosty Cardputer"};
    hosty::FixedString<96> access_token;
    hosty::PowerPolicy power;
    bool sound_enabled = true;
    bool quiet_hours_enabled = true;
    std::uint8_t quiet_start_hour = 22;
    std::uint8_t quiet_end_hour = 7;
};

class SettingsStore {
public:
    bool load(DeviceSettings& settings) const;
    bool save(const DeviceSettings& settings) const;
    bool clear_access_token() const;
};
