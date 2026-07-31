#pragma once

#include "cardputer/key_input.hpp"

#include <cstdint>

namespace cardputer {

// Native ESP-IDF keyboard driver for Cardputer ADV's TCA8418. The matrix remap
// and key layout follow M5Stack's MIT-licensed M5Cardputer 1.2.0 implementation,
// but storage is a fixed 56-bit mask rather than dynamically allocated vectors.
class Tca8418Keyboard {
public:
    bool begin();
    bool read(KeyInput& input);
    [[nodiscard]] bool activity_pending() const;

private:
    static void interrupt_handler(void* context);
    bool read_register(std::uint8_t address, std::uint8_t& value) const;
    bool write_register(std::uint8_t address, std::uint8_t value) const;
    bool read_raw_event(std::uint8_t& event);
    bool translate(std::uint8_t row, std::uint8_t column, KeyInput& input) const;
    [[nodiscard]] bool pressed(std::uint8_t row, std::uint8_t column) const;

    volatile bool interrupt_pending_ = false;
    std::uint64_t pressed_mask_ = 0;
};

}  // namespace cardputer

