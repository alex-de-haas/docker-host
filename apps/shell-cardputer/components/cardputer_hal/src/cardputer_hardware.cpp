#include "cardputer/cardputer_hardware.hpp"

#include <M5Unified.hpp>
#include <esp_log.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace cardputer {
namespace {

constexpr const char* kTag = "cardputer_display";

std::uint64_t frame_hash(const void* buffer, std::uint32_t length) {
    const auto* bytes = static_cast<const std::uint8_t*>(buffer);
    std::uint64_t hash = 1'469'598'103'934'665'603ULL;
    for (std::uint32_t index = 0; index < length; ++index) {
        hash ^= bytes[index];
        hash *= 1'099'511'628'211ULL;
    }
    return hash;
}

}  // namespace

CardputerHardware::CardputerHardware() : frame_(&M5.Display) {}

bool CardputerHardware::begin() {
    auto config = M5.config();
    config.clear_display = true;
    config.internal_imu = true;
    config.internal_spk = true;
    config.output_power = true;
    M5.begin(config);
    if (M5.getBoard() != m5::board_t::board_M5CardputerADV) return false;

    M5.Display.setRotation(1);
    M5.Display.setTextSize(1);
    M5.Display.setTextDatum(m5gfx::textdatum_t::top_left);
    M5.Display.setBrightness(80);
    M5.Speaker.setVolume(64);
    frame_.setPsram(false);
    frame_.setColorDepth(8);
    frame_ready_ = frame_.createSprite(M5.Display.width(), M5.Display.height()) != nullptr;
    if (!frame_ready_) return false;
    frame_.setTextSize(1);
    frame_.setTextDatum(m5gfx::textdatum_t::top_left);
    return keyboard_.begin();
}

void CardputerHardware::update() {
    M5.update();
}

void CardputerHardware::set_wake_task(TaskHandle_t task) { keyboard_.set_wake_task(task); }

bool CardputerHardware::keyboard_activity_pending() const { return keyboard_.activity_pending(); }

bool CardputerHardware::read_key(KeyInput& input) { return keyboard_.read(input); }

std::uint16_t CardputerHardware::motion_delta_mg() {
    M5.Imu.update();
    float x = 0;
    float y = 0;
    float z = 0;
    if (!M5.Imu.getAccel(&x, &y, &z)) return 0;
    if (!accelerometer_ready_) {
        previous_x_ = x;
        previous_y_ = y;
        previous_z_ = z;
        accelerometer_ready_ = true;
        return 0;
    }
    const float delta = std::fabs(x - previous_x_) + std::fabs(y - previous_y_) + std::fabs(z - previous_z_);
    previous_x_ = x;
    previous_y_ = y;
    previous_z_ = z;
    return static_cast<std::uint16_t>(std::min(65'535.0F, delta * 1000.0F));
}

void CardputerHardware::reset_motion_reference() { accelerometer_ready_ = false; }

int CardputerHardware::battery_percent() const { return static_cast<int>(M5.Power.getBatteryLevel()); }

bool CardputerHardware::charging() const { return M5.Power.isCharging() == m5::Power_Class::is_charging; }

void CardputerHardware::display_on() {
    if (display_awake_) return;
    M5.Display.wakeup();
    M5.Display.setBrightness(80);
    display_awake_ = true;
    force_present_ = true;
}

void CardputerHardware::display_off() {
    if (!display_awake_) return;
    M5.Display.setBrightness(0);
    M5.Display.sleep();
    display_awake_ = false;
}

void CardputerHardware::play_notification(hosty::NotificationLevel level) {
    const std::uint16_t frequency = level == hosty::NotificationLevel::Error ? 1'320 :
                                    level == hosty::NotificationLevel::Warning ? 1'000 : 784;
    M5.Speaker.tone(frequency, 90);
}

int CardputerHardware::width() const { return frame_ready_ ? frame_.width() : M5.Display.width(); }
int CardputerHardware::height() const { return frame_ready_ ? frame_.height() : M5.Display.height(); }
void CardputerHardware::fill(hosty::Color color) { frame_.fillScreen(color); }
void CardputerHardware::fill_rect(int x, int y, int width_value, int height_value, hosty::Color color) {
    frame_.fillRect(x, y, width_value, height_value, color);
}

void CardputerHardware::text(int x, int y, std::string_view value, hosty::Color foreground, hosty::Color background) {
    char buffer[160];
    const std::size_t length = std::min(value.size(), sizeof(buffer) - 1);
    std::memcpy(buffer, value.data(), length);
    buffer[length] = '\0';
    frame_.setTextColor(foreground, background);
    frame_.drawString(buffer, x, y);
}

void CardputerHardware::present() {
    if (!frame_ready_ || !display_awake_) return;
    const std::uint64_t hash = frame_hash(frame_.getBuffer(), frame_.bufferLength());
    if (!force_present_ && has_presented_frame_ && hash == presented_frame_hash_) {
        ESP_LOGD(kTag, "Skipped unchanged framebuffer");
        return;
    }
    frame_.pushSprite(0, 0);
    presented_frame_hash_ = hash;
    has_presented_frame_ = true;
    force_present_ = false;
    ESP_LOGD(kTag, "Presented framebuffer %08lx%08lx", static_cast<unsigned long>(hash >> 32U),
             static_cast<unsigned long>(hash & 0xFFFFFFFFULL));
}

}  // namespace cardputer
