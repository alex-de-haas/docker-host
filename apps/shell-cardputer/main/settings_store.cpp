#include "settings_store.hpp"

#include <nvs.h>

#include <array>

namespace {

constexpr const char* kNamespace = "hosty_shell";

template <std::size_t Capacity>
void read_string(nvs_handle_t handle, const char* key, hosty::FixedString<Capacity>& value) {
    std::array<char, Capacity + 1> buffer{};
    std::size_t length = buffer.size();
    if (nvs_get_str(handle, key, buffer.data(), &length) == ESP_OK) value.assign_truncated(buffer.data());
}

template <std::size_t Capacity>
bool write_string(nvs_handle_t handle, const char* key, const hosty::FixedString<Capacity>& value) {
    return nvs_set_str(handle, key, value.c_str()) == ESP_OK;
}

}  // namespace

bool SettingsStore::load(DeviceSettings& settings) const {
    settings = {};
    nvs_handle_t handle = 0;
    if (nvs_open(kNamespace, NVS_READONLY, &handle) != ESP_OK) return false;

    read_string(handle, "ssid", settings.wifi_ssid);
    read_string(handle, "wifi_password", settings.wifi_password);
    read_string(handle, "core_origin", settings.core_origin);
    read_string(handle, "time_zone", settings.time_zone);
    read_string(handle, "device_label", settings.device_label);
    read_string(handle, "access_token", settings.access_token);

    std::uint32_t value32 = 0;
    std::uint16_t value16 = 0;
    std::uint8_t value8 = 0;
    if (nvs_get_u32(handle, "display_ms", &value32) == ESP_OK) settings.power.display_timeout_ms = value32;
    if (nvs_get_u32(handle, "motion_cd_ms", &value32) == ESP_OK) settings.power.motion_cooldown_ms = value32;
    if (nvs_get_u16(handle, "motion_mg", &value16) == ESP_OK) settings.power.motion_threshold_mg = value16;
    if (nvs_get_u8(handle, "motion_wake", &value8) == ESP_OK) settings.power.motion_wake = value8 != 0;
    if (nvs_get_u8(handle, "sound", &value8) == ESP_OK) settings.sound_enabled = value8 != 0;
    if (nvs_get_u8(handle, "quiet", &value8) == ESP_OK) settings.quiet_hours_enabled = value8 != 0;
    if (nvs_get_u8(handle, "quiet_start", &value8) == ESP_OK && value8 < 24) settings.quiet_start_hour = value8;
    if (nvs_get_u8(handle, "quiet_end", &value8) == ESP_OK && value8 < 24) settings.quiet_end_hour = value8;
    nvs_close(handle);
    return !settings.wifi_ssid.empty() && !settings.core_origin.empty();
}

bool SettingsStore::save(const DeviceSettings& settings) const {
    nvs_handle_t handle = 0;
    if (nvs_open(kNamespace, NVS_READWRITE, &handle) != ESP_OK) return false;
    const bool written = write_string(handle, "ssid", settings.wifi_ssid) &&
        write_string(handle, "wifi_password", settings.wifi_password) &&
        write_string(handle, "core_origin", settings.core_origin) &&
        write_string(handle, "time_zone", settings.time_zone) &&
        write_string(handle, "device_label", settings.device_label) &&
        write_string(handle, "access_token", settings.access_token) &&
        nvs_set_u32(handle, "display_ms", settings.power.display_timeout_ms) == ESP_OK &&
        nvs_set_u32(handle, "motion_cd_ms", settings.power.motion_cooldown_ms) == ESP_OK &&
        nvs_set_u16(handle, "motion_mg", settings.power.motion_threshold_mg) == ESP_OK &&
        nvs_set_u8(handle, "motion_wake", settings.power.motion_wake ? 1 : 0) == ESP_OK &&
        nvs_set_u8(handle, "sound", settings.sound_enabled ? 1 : 0) == ESP_OK &&
        nvs_set_u8(handle, "quiet", settings.quiet_hours_enabled ? 1 : 0) == ESP_OK &&
        nvs_set_u8(handle, "quiet_start", settings.quiet_start_hour) == ESP_OK &&
        nvs_set_u8(handle, "quiet_end", settings.quiet_end_hour) == ESP_OK &&
        nvs_commit(handle) == ESP_OK;
    nvs_close(handle);
    return written;
}

bool SettingsStore::clear_access_token() const {
    nvs_handle_t handle = 0;
    if (nvs_open(kNamespace, NVS_READWRITE, &handle) != ESP_OK) return false;
    const esp_err_t erased = nvs_erase_key(handle, "access_token");
    const bool result = (erased == ESP_OK || erased == ESP_ERR_NVS_NOT_FOUND) && nvs_commit(handle) == ESP_OK;
    nvs_close(handle);
    return result;
}
