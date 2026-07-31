#pragma once

#include "cardputer/key_input.hpp"
#include "cardputer/tca8418_keyboard.hpp"
#include "hosty/render.hpp"

#include <cstdint>
#include <string_view>

namespace cardputer {

class CardputerHardware final : public hosty::Canvas {
public:
    bool begin();
    void update();
    bool read_key(KeyInput& input);

    [[nodiscard]] std::uint16_t motion_delta_mg();
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

private:
    Tca8418Keyboard keyboard_;
    float previous_x_ = 0;
    float previous_y_ = 0;
    float previous_z_ = 1;
    bool accelerometer_ready_ = false;
    bool display_awake_ = true;
};

}  // namespace cardputer

