#pragma once

#include "cardputer/key_input.hpp"
#include "cardputer/tca8418_keyboard.hpp"
#include "hosty/render.hpp"

#include <M5Unified.hpp>
#include <freertos/task.h>

#include <cstdint>
#include <string_view>

namespace cardputer {

class CardputerHardware final : public hosty::Canvas {
public:
    CardputerHardware();

    /// What to power up. A measurement run wants as little alive as possible: the speaker amplifier
    /// and the IMU both draw current continuously, which corrupts the very reading being taken, and the
    /// amplifier additionally pops audibly each time the device sleeps and wakes. Nothing is rendered
    /// during a run either, so the 32 KB frame buffer is skipped with them.
    enum class Peripherals : std::uint8_t { Full, MeasurementOnly };

    bool begin(Peripherals peripherals = Peripherals::Full);
    void update();
    void set_wake_task(TaskHandle_t task);
    [[nodiscard]] bool keyboard_activity_pending() const;
    bool read_key(KeyInput& input);

    [[nodiscard]] std::uint16_t motion_delta_mg();
    void reset_motion_reference();
    [[nodiscard]] int battery_percent() const;
    [[nodiscard]] bool charging() const;
    void display_on();
    void display_off();
    void play_notification(hosty::NotificationLevel level);

    [[nodiscard]] int width() const override;
    [[nodiscard]] int height() const override;
    void fill(hosty::Color color) override;
    void fill_rect(int x, int y, int width, int height, hosty::Color color) override;
    void text(int x, int y, std::string_view value, hosty::Color foreground, hosty::Color background) override;
    void present() override;

private:
    M5Canvas frame_;
    Tca8418Keyboard keyboard_;
    float previous_x_ = 0;
    float previous_y_ = 0;
    float previous_z_ = 1;
    bool accelerometer_ready_ = false;
    bool display_awake_ = true;
    bool frame_ready_ = false;
    bool force_present_ = true;
    bool has_presented_frame_ = false;
    std::uint64_t presented_frame_hash_ = 0;
};

}  // namespace cardputer
