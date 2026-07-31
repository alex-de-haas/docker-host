#pragma once

#include "hosty/bounded.hpp"
#include "hosty/power.hpp"
#include "hosty/state.hpp"

#include <cstdint>
#include <string_view>

namespace hosty {

using Color = std::uint16_t;

namespace colors {
inline constexpr Color Background = 0x0861;
inline constexpr Color Panel = 0x10C3;
inline constexpr Color PanelRaised = 0x1925;
inline constexpr Color Text = 0xFFFF;
inline constexpr Color Muted = 0xA514;
inline constexpr Color Accent = 0x2E9F;
inline constexpr Color Success = 0x4E68;
inline constexpr Color Warning = 0xFDC0;
inline constexpr Color Error = 0xF986;
inline constexpr Color Border = 0x31A6;
}  // namespace colors

class Canvas {
public:
    virtual ~Canvas() = default;
    [[nodiscard]] virtual int width() const = 0;
    [[nodiscard]] virtual int height() const = 0;
    virtual void fill(Color color) = 0;
    virtual void fill_rect(int x, int y, int width, int height, Color color) = 0;
    virtual void text(int x, int y, std::string_view value, Color foreground, Color background) = 0;
};

struct UiState {
    View view = View::Dashboard;
    std::uint16_t selected_app = 0;
    std::uint16_t app_scroll = 0;
    int battery_percent = -1;
    bool charging = false;
    PowerMode power_mode = PowerMode::Active;
    FixedString<32> firmware_version;
    FixedString<32> device_label;
    FixedString<96> endpoint;
    FixedString<48> status_message;
    FixedString<48> overlay_title;
    FixedString<512> overlay_body;
    bool overlay_visible = false;
};

class Renderer {
public:
    void render(Canvas& canvas, const ClientState& state, const UiState& ui) const;

private:
    void header(Canvas& canvas, const ClientState& state, const UiState& ui, std::string_view title) const;
    void footer(Canvas& canvas, View selected) const;
    void dashboard(Canvas& canvas, const ClientState& state, const UiState& ui) const;
    void apps(Canvas& canvas, const ClientState& state, const UiState& ui) const;
    void updates(Canvas& canvas, const ClientState& state, const UiState& ui) const;
    void device(Canvas& canvas, const ClientState& state, const UiState& ui) const;
    void overlay(Canvas& canvas, const UiState& ui) const;
};

}  // namespace hosty
