#pragma once

#include <cstdint>

namespace cardputer {

enum class KeyCode : std::uint8_t {
    None,
    Character,
    Enter,
    Backspace,
    Delete,
    Tab,
    Escape,
    Up,
    Down,
    Left,
    Right,
    F1,
    F2,
    F3,
    F4,
};

struct KeyInput {
    KeyCode code = KeyCode::None;
    char character = 0;
    bool shift = false;
    bool control = false;
    bool alt = false;
    bool function = false;
};

}  // namespace cardputer

