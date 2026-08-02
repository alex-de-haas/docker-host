#include "cardputer/tca8418_keyboard.hpp"

#include <M5Unified.hpp>
#include <driver/gpio.h>
#include <esp_attr.h>
#include <esp_err.h>

namespace cardputer {
namespace {

constexpr std::uint8_t kAddress = 0x34;
constexpr std::uint32_t kFrequency = 400'000;
constexpr gpio_num_t kInterruptPin = GPIO_NUM_11;

constexpr std::uint8_t kConfig = 0x01;
constexpr std::uint8_t kInterruptStatus = 0x02;
constexpr std::uint8_t kEventCount = 0x03;
constexpr std::uint8_t kFirstEvent = 0x04;
constexpr std::uint8_t kRows = 0x1D;
constexpr std::uint8_t kColumnsLow = 0x1E;
constexpr std::uint8_t kColumnsHigh = 0x1F;
constexpr std::uint8_t kDebounceLow = 0x29;
constexpr std::uint8_t kDebounceMiddle = 0x2A;
constexpr std::uint8_t kDebounceHigh = 0x2B;

constexpr std::uint8_t kFnRow = 2;
constexpr std::uint8_t kFnColumn = 0;
constexpr std::uint8_t kShiftRow = 2;
constexpr std::uint8_t kShiftColumn = 1;
constexpr std::uint8_t kControlRow = 3;
constexpr std::uint8_t kControlColumn = 0;
constexpr std::uint8_t kAltRow = 3;
constexpr std::uint8_t kAltColumn = 2;

struct KeyDefinition {
    char normal;
    char shifted;
    KeyCode direct;
    KeyCode function;
};

constexpr KeyDefinition key(char normal, char shifted = 0, KeyCode function = KeyCode::None) {
    return {normal, shifted == 0 ? normal : shifted, KeyCode::Character, function};
}

constexpr KeyDefinition special(KeyCode direct, KeyCode function = KeyCode::None) {
    return {0, 0, direct, function};
}

constexpr KeyDefinition kLayout[4][14] = {
    {
        key('`', '~', KeyCode::Escape), key('1', '!', KeyCode::F1), key('2', '@', KeyCode::F2),
        key('3', '#', KeyCode::F3), key('4', '$', KeyCode::F4), key('5', '%'), key('6', '^'),
        key('7', '&'), key('8', '*'), key('9', '('), key('0', ')'), key('-', '_'), key('=', '+'),
        special(KeyCode::Backspace, KeyCode::Delete),
    },
    {
        special(KeyCode::Tab), key('q', 'Q'), key('w', 'W'), key('e', 'E'), key('r', 'R'), key('t', 'T'),
        key('y', 'Y'), key('u', 'U'), key('i', 'I'), key('o', 'O'), key('p', 'P'), key('[', '{'),
        key(']', '}'), key('\\', '|'),
    },
    {
        special(KeyCode::None), special(KeyCode::None), key('a', 'A'), key('s', 'S'), key('d', 'D'),
        key('f', 'F'), key('g', 'G'), key('h', 'H'), key('j', 'J'), key('k', 'K'), key('l', 'L'),
        key(';', ':', KeyCode::Up), key('\'', '"'), special(KeyCode::Enter),
    },
    {
        special(KeyCode::None), special(KeyCode::None), special(KeyCode::None), key('z', 'Z'), key('x', 'X'),
        key('c', 'C'), key('v', 'V'), key('b', 'B'), key('n', 'N'), key('m', 'M'), key(',', '<', KeyCode::Left),
        key('.', '>', KeyCode::Down), key('/', '?', KeyCode::Right), key(' '),
    },
};

}  // namespace

bool Tca8418Keyboard::begin() {
    std::uint8_t probe = 0;
    if (!read_register(kConfig, probe)) return false;

    // Seven physical rows and eight columns are remapped into the Cardputer's
    // logical 4 x 14 layout. Lowest TCA8418 pins are selected for the matrix.
    if (!write_register(kRows, 0x7F) || !write_register(kColumnsLow, 0xFF) ||
        !write_register(kColumnsHigh, 0x00) || !write_register(kDebounceLow, 0x00) ||
        !write_register(kDebounceMiddle, 0x00) || !write_register(kDebounceHigh, 0x00)) {
        return false;
    }

    std::uint8_t event = 0;
    do {
        if (!read_register(kFirstEvent, event)) return false;
    } while (event != 0);
    if (!write_register(kInterruptStatus, 0x03) || !write_register(kConfig, 0x01)) return false;

    gpio_config_t config{};
    config.pin_bit_mask = 1ULL << static_cast<unsigned>(kInterruptPin);
    config.mode = GPIO_MODE_INPUT;
    config.pull_up_en = GPIO_PULLUP_ENABLE;
    config.pull_down_en = GPIO_PULLDOWN_DISABLE;
    config.intr_type = GPIO_INTR_NEGEDGE;
    if (gpio_config(&config) != ESP_OK) return false;
    const esp_err_t install = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
    if (install != ESP_OK && install != ESP_ERR_INVALID_STATE) return false;
    return gpio_isr_handler_add(kInterruptPin, &Tca8418Keyboard::interrupt_handler, this) == ESP_OK;
}

void Tca8418Keyboard::set_wake_task(TaskHandle_t task) { wake_task_ = task; }

bool Tca8418Keyboard::read(KeyInput& input) {
    input = {};
    std::uint8_t count = 0;
    if (!read_register(kEventCount, count)) return false;
    count &= 0x0F;
    if (count == 0) {
        interrupt_pending_ = false;
        static_cast<void>(write_register(kInterruptStatus, 0x01));
        return false;
    }

    for (std::uint8_t index = 0; index < count; ++index) {
        std::uint8_t raw = 0;
        if (!read_raw_event(raw) || (raw & 0x7F) == 0) continue;
        const bool is_press = (raw & 0x80) != 0;
        const std::uint8_t encoded = static_cast<std::uint8_t>((raw & 0x7F) - 1);
        const std::uint8_t raw_row = encoded / 10;
        const std::uint8_t raw_column = encoded % 10;
        const std::uint8_t column = static_cast<std::uint8_t>(raw_row * 2 + (raw_column > 3 ? 1 : 0));
        const std::uint8_t row = static_cast<std::uint8_t>((raw_column + 4) % 4);
        if (row >= 4 || column >= 14) continue;

        const std::uint64_t bit = 1ULL << (row * 14 + column);
        if (is_press) pressed_mask_ |= bit;
        else pressed_mask_ &= ~bit;
        if (is_press && translate(row, column, input)) {
            static_cast<void>(write_register(kInterruptStatus, 0x01));
            return true;
        }
    }
    static_cast<void>(write_register(kInterruptStatus, 0x01));
    return false;
}

bool Tca8418Keyboard::activity_pending() const {
    return interrupt_pending_ || gpio_get_level(kInterruptPin) == 0;
}

void IRAM_ATTR Tca8418Keyboard::interrupt_handler(void* context) {
    auto* keyboard = static_cast<Tca8418Keyboard*>(context);
    keyboard->interrupt_pending_ = true;
    if (keyboard->wake_task_ != nullptr) {
        BaseType_t higher_priority_task_woken = pdFALSE;
        vTaskNotifyGiveFromISR(keyboard->wake_task_, &higher_priority_task_woken);
        portYIELD_FROM_ISR(higher_priority_task_woken);
    }
}

bool Tca8418Keyboard::read_register(std::uint8_t address, std::uint8_t& value) const {
    return M5.In_I2C.readRegister(kAddress, address, &value, 1, kFrequency);
}

bool Tca8418Keyboard::write_register(std::uint8_t address, std::uint8_t value) const {
    return M5.In_I2C.writeRegister8(kAddress, address, value, kFrequency);
}

bool Tca8418Keyboard::read_raw_event(std::uint8_t& event) {
    return read_register(kFirstEvent, event);
}

bool Tca8418Keyboard::translate(std::uint8_t row, std::uint8_t column, KeyInput& input) const {
    input.shift = pressed(kShiftRow, kShiftColumn);
    input.control = pressed(kControlRow, kControlColumn);
    input.alt = pressed(kAltRow, kAltColumn);
    input.function = pressed(kFnRow, kFnColumn);

    if ((row == kFnRow && column == kFnColumn) || (row == kShiftRow && column == kShiftColumn) ||
        (row == kControlRow && column == kControlColumn) || (row == kAltRow && column == kAltColumn) ||
        (row == 3 && column == 1)) {
        return false;
    }

    const KeyDefinition& definition = kLayout[row][column];
    if (input.function && definition.function != KeyCode::None) {
        input.code = definition.function;
        return true;
    }
    input.code = definition.direct;
    if (definition.direct == KeyCode::Character) input.character = input.shift ? definition.shifted : definition.normal;
    return input.code != KeyCode::None;
}

bool Tca8418Keyboard::pressed(std::uint8_t row, std::uint8_t column) const {
    return (pressed_mask_ & (1ULL << (row * 14 + column))) != 0;
}

}  // namespace cardputer
