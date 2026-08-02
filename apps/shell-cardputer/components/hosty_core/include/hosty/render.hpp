#pragma once

#include "hosty/bounded.hpp"
#include "hosty/power.hpp"
#include "hosty/state.hpp"

#include <cstdint>
#include <string_view>

namespace hosty {

using Color = std::uint16_t;

enum class ColorTheme : std::uint8_t { Amber, Ocean, Violet };
// Alert is Info that can also be dismissed for good: it offers "mark read", which is what clears the
// unread counter and the Dashboard hint. Opening the alert list is deliberately not enough — the web
// Shell marks read on an explicit action too, and a console that cleared the counter just because
// somebody glanced at it would lose the one signal saying the host needs attention.
enum class OverlayMode : std::uint8_t { Info, Confirmation, Menu, Alert };
enum class DeviceItem : std::uint8_t {
    StandbyMode,
    ScreenTimeout,
    AlertInterval,
    MotionWake,
    Theme,
    Sound,
    QuietHours,
    Setup,
    CoreActions,
    DeviceActions,
    Count,
};

struct ThemePalette {
    Color background;
    Color panel;
    Color panel_raised;
    Color text;
    Color muted;
    Color accent;
    Color success;
    Color warning;
    Color error;
    Color border;
};

[[nodiscard]] const ThemePalette& theme_palette(ColorTheme theme);
[[nodiscard]] std::string_view theme_name(ColorTheme theme);

// Setup is rendered before persisted preferences are available, so it uses
// the default Amber palette.
namespace colors {
inline constexpr Color Background = 0x2000;
inline constexpr Color Panel = 0x4920;
inline constexpr Color PanelRaised = 0x6120;
inline constexpr Color Text = 0xF62D;
inline constexpr Color Muted = 0x9C4D;
inline constexpr Color Accent = 0xFCE3;
inline constexpr Color Success = 0x56B7;
inline constexpr Color Warning = 0xFE8C;
inline constexpr Color Error = 0xFAEE;
inline constexpr Color Border = 0x6A40;
}  // namespace colors

class Canvas {
public:
    virtual ~Canvas() = default;
    [[nodiscard]] virtual int width() const = 0;
    [[nodiscard]] virtual int height() const = 0;
    virtual void fill(Color color) = 0;
    virtual void fill_rect(int x, int y, int width, int height, Color color) = 0;
    virtual void text(int x, int y, std::string_view value, Color foreground, Color background) = 0;
    virtual void present() {}
};

struct MenuItem {
    FixedString<32> label;
    char shortcut = 0;
};

struct UiState {
    View view = View::Dashboard;
    std::uint16_t selected_app = 0;
    std::uint16_t app_scroll = 0;
    std::uint8_t selected_device = 0;
    std::uint8_t device_scroll = 0;
    int battery_percent = -1;
    bool charging = false;
    PowerMode power_mode = PowerMode::Active;
    ColorTheme theme = ColorTheme::Amber;
    bool eco_standby = false;
    std::uint32_t display_timeout_ms = 30'000;
    std::uint32_t alert_interval_ms = 10 * 60'000;
    bool motion_wake = false;
    bool sound_enabled = true;
    bool quiet_hours_enabled = true;
    FixedString<32> firmware_version;
    FixedString<32> device_label;
    FixedString<96> endpoint;
    // Progress text for the boot and reconnect screens, which fold it into their overlay body. It is
    // deliberately not rendered anywhere in the steady-state UI: an operation's outcome shows up as the
    // state changing, and a failure opens an overlay the operator has to dismiss.
    FixedString<48> status_message;
    std::uint64_t now_ms = 0;
    FixedString<48> overlay_title;
    FixedString<512> overlay_body;
    FixedVector<MenuItem, 8> menu_items;
    std::uint8_t selected_menu_item = 0;
    std::uint8_t menu_scroll = 0;
    OverlayMode overlay_mode = OverlayMode::Info;
    bool overlay_visible = false;
};

class Renderer {
public:
    void render(Canvas& canvas, const ClientState& state, const UiState& ui) const;

private:
    void header(Canvas& canvas, const ClientState& state, const UiState& ui,
                const ThemePalette& palette) const;
    void footer(Canvas& canvas, const ClientState& state, const UiState& ui,
                const ThemePalette& palette) const;
    void dashboard(Canvas& canvas, const ClientState& state, const UiState& ui,
                   const ThemePalette& palette) const;
    void apps(Canvas& canvas, const ClientState& state, const UiState& ui,
              const ThemePalette& palette) const;
    void updates(Canvas& canvas, const ClientState& state, const UiState& ui,
                 const ThemePalette& palette) const;
    void device(Canvas& canvas, const ClientState& state, const UiState& ui,
                const ThemePalette& palette) const;
    void overlay(Canvas& canvas, const UiState& ui, const ThemePalette& palette) const;
};

}  // namespace hosty
