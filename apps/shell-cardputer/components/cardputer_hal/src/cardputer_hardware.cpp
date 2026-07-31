#include "cardputer/cardputer_hardware.hpp"

#include <M5Unified.hpp>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace cardputer {

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
    return keyboard_.begin();
}

void CardputerHardware::update() {
    M5.update();
    M5.Imu.update();
}

bool CardputerHardware::read_key(KeyInput& input) { return keyboard_.read(input); }

std::uint16_t CardputerHardware::motion_delta_mg() {
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

int CardputerHardware::battery_percent() const { return static_cast<int>(M5.Power.getBatteryLevel()); }

bool CardputerHardware::charging() const { return M5.Power.isCharging() == m5::Power_Class::is_charging; }

void CardputerHardware::display_on() {
    if (display_awake_) return;
    M5.Display.wakeup();
    M5.Display.setBrightness(80);
    display_awake_ = true;
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

int CardputerHardware::width() const { return M5.Display.width(); }
int CardputerHardware::height() const { return M5.Display.height(); }
void CardputerHardware::fill(hosty::Color color) { M5.Display.fillScreen(color); }
void CardputerHardware::fill_rect(int x, int y, int width_value, int height_value, hosty::Color color) {
    M5.Display.fillRect(x, y, width_value, height_value, color);
}

void CardputerHardware::text(int x, int y, std::string_view value, hosty::Color foreground, hosty::Color background) {
    char buffer[160];
    const std::size_t length = std::min(value.size(), sizeof(buffer) - 1);
    std::memcpy(buffer, value.data(), length);
    buffer[length] = '\0';
    M5.Display.setTextColor(foreground, background);
    M5.Display.drawString(buffer, x, y);
}

}  // namespace cardputer

