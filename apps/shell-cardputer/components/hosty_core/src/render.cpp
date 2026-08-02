#include "hosty/render.hpp"

#include <algorithm>
#include <cstdio>

namespace hosty {
namespace {

constexpr int kHeaderHeight = 18;
constexpr int kFooterHeight = 15;
constexpr int kVisibleDeviceItems = 5;
constexpr int kVisibleMenuItems = 5;

constexpr ThemePalette kAmber{
    0x2000, 0x4920, 0x6120, 0xF62D, 0x9C4D, 0xFCE3, 0x56B7, 0xFE8C, 0xFAEE, 0x6A40,
};
constexpr ThemePalette kOcean{
    0x000A, 0x012A, 0x024A, 0xD7BE, 0x7D35, 0x3DFF, 0x4E8F, 0xF5EA, 0xFB8E, 0x0295,
};
constexpr ThemePalette kViolet{
    0x200A, 0x212A, 0x492A, 0xEEFE, 0x9C55, 0xB47F, 0x66B8, 0xFE4D, 0xFB51, 0x6A95,
};

std::string_view view_name(View view) {
    switch (view) {
        case View::Dashboard: return "Home";
        case View::Apps: return "Apps";
        case View::Updates: return "Updates";
        case View::Device: return "Device";
    }
    return "Hosty";
}

std::string_view header_status(ConnectionState state) {
    switch (state) {
        case ConnectionState::Unconfigured: return "Setup";
        case ConnectionState::WifiConnecting: return "Wi-Fi...";
        case ConnectionState::TimeSyncing: return "Setting time";
        case ConnectionState::Authorizing: return "Authorize";
        case ConnectionState::Connecting: return "Syncing...";
        case ConnectionState::Online: return "Synced";
        case ConnectionState::Stale: return "Stale";
        case ConnectionState::Unauthorized: return "Revoked";
        case ConnectionState::UnsupportedCore: return "Upgrade Core";
        case ConnectionState::Offline: return "Offline";
    }
    return "Unknown";
}

Color connection_color(ConnectionState state, const ThemePalette& palette) {
    switch (state) {
        case ConnectionState::Online: return palette.success;
        case ConnectionState::Stale:
        case ConnectionState::WifiConnecting:
        case ConnectionState::TimeSyncing:
        case ConnectionState::Authorizing:
        case ConnectionState::Connecting: return palette.warning;
        case ConnectionState::Unauthorized:
        case ConnectionState::UnsupportedCore:
        case ConnectionState::Offline: return palette.error;
        case ConnectionState::Unconfigured: return palette.muted;
    }
    return palette.muted;
}

Color state_color(RuntimeState state, const ThemePalette& palette) {
    switch (state) {
        case RuntimeState::Running: return palette.success;
        case RuntimeState::Starting:
        case RuntimeState::Stopping: return palette.warning;
        case RuntimeState::Failed: return palette.error;
        case RuntimeState::Stopped:
        case RuntimeState::Unknown: return palette.muted;
    }
    return palette.muted;
}

void key_hint(Canvas& canvas, int& x, int y, std::string_view key, std::string_view label,
              const ThemePalette& palette) {
    const int key_width = static_cast<int>(key.size()) * 6 + 4;
    canvas.fill_rect(x, y, key_width, 11, palette.accent);
    canvas.text(x + 2, y + 2, key, palette.background, palette.accent);
    x += key_width + 3;
    canvas.text(x, y + 2, label, palette.text, palette.panel_raised);
    x += static_cast<int>(label.size()) * 6 + 8;
}

// Age of the snapshot the Home numbers were read from, in the coarsest unit that is still honest.
// A console is only worth trusting if it says how old what it shows is.
void format_sync_age(const ClientState& state, std::uint64_t now_ms, char* output, std::size_t size) {
    if (!state.synchronized() || state.last_sync_ms() == 0 || now_ms < state.last_sync_ms()) {
        std::snprintf(output, size, "Waiting for Core");
        return;
    }

    const std::uint64_t age_seconds = (now_ms - state.last_sync_ms()) / 1000;
    if (age_seconds < 10) {
        std::snprintf(output, size, "Synced just now");
    } else if (age_seconds < 60) {
        std::snprintf(output, size, "Synced %us ago", static_cast<unsigned>(age_seconds));
    } else if (age_seconds < 3600) {
        std::snprintf(output, size, "Synced %um ago", static_cast<unsigned>(age_seconds / 60));
    } else {
        std::snprintf(output, size, "Synced %uh ago", static_cast<unsigned>(age_seconds / 3600));
    }
}

std::string_view device_label(DeviceItem item) {
    switch (item) {
        case DeviceItem::StandbyMode: return "Standby";
        case DeviceItem::ScreenTimeout: return "Screen off";
        case DeviceItem::AlertInterval: return "Check alerts";
        case DeviceItem::MotionWake: return "Motion wake";
        case DeviceItem::Theme: return "Theme";
        case DeviceItem::Sound: return "Sound";
        case DeviceItem::QuietHours: return "Quiet hours";
        case DeviceItem::Setup: return "Connection setup";
        case DeviceItem::CoreActions: return "Core actions";
        case DeviceItem::DeviceActions: return "Device actions";
        case DeviceItem::Count: break;
    }
    return "Unknown";
}

void format_duration(char* output, std::size_t size, std::uint32_t duration_ms) {
    if (duration_ms < 60'000) std::snprintf(output, size, "%u sec", static_cast<unsigned>(duration_ms / 1'000));
    else std::snprintf(output, size, "%u min", static_cast<unsigned>(duration_ms / 60'000));
}

}  // namespace

const ThemePalette& theme_palette(ColorTheme theme) {
    switch (theme) {
        case ColorTheme::Amber: return kAmber;
        case ColorTheme::Ocean: return kOcean;
        case ColorTheme::Violet: return kViolet;
    }
    return kAmber;
}

std::string_view theme_name(ColorTheme theme) {
    switch (theme) {
        case ColorTheme::Amber: return "Amber";
        case ColorTheme::Ocean: return "Ocean";
        case ColorTheme::Violet: return "Violet";
    }
    return "Amber";
}

void Renderer::render(Canvas& canvas, const ClientState& state, const UiState& ui) const {
    const auto& palette = theme_palette(ui.theme);
    canvas.fill(palette.background);
    header(canvas, state, ui, palette);
    switch (ui.view) {
        case View::Dashboard: dashboard(canvas, state, ui, palette); break;
        case View::Apps: apps(canvas, state, ui, palette); break;
        case View::Updates: updates(canvas, state, ui, palette); break;
        case View::Device: device(canvas, state, ui, palette); break;
    }
    footer(canvas, state, ui, palette);
    if (ui.overlay_visible) overlay(canvas, ui, palette);
    canvas.present();
}

void Renderer::header(Canvas& canvas, const ClientState& state, const UiState& ui,
                      const ThemePalette& palette) const {
    canvas.fill_rect(0, 0, canvas.width(), kHeaderHeight, palette.panel_raised);
    const std::string_view status = header_status(state.connection());
    canvas.text(5, 5, status, connection_color(state.connection(), palette), palette.panel_raised);

    char page[20];
    std::snprintf(page, sizeof(page), "< %s >", view_name(ui.view).data());
    const int page_x = (canvas.width() - static_cast<int>(std::char_traits<char>::length(page)) * 6) / 2;
    canvas.text(page_x, 5, page, palette.accent, palette.panel_raised);

    char battery[20];
    if (ui.battery_percent >= 0) {
        std::snprintf(battery, sizeof(battery), "%d%%%s", ui.battery_percent, ui.charging ? "+" : "");
    } else {
        std::snprintf(battery, sizeof(battery), "--%%");
    }
    const int battery_x = canvas.width() - static_cast<int>(std::char_traits<char>::length(battery)) * 6 - 5;
    canvas.text(battery_x, 5, battery, palette.text, palette.panel_raised);
}

void Renderer::footer(Canvas& canvas, const ClientState& state, const UiState& ui,
                      const ThemePalette& palette) const {
    const int y = canvas.height() - kFooterHeight;
    canvas.fill_rect(0, y, canvas.width(), kFooterHeight, palette.panel_raised);
    int x = 4;
    if (ui.overlay_visible) {
        if (ui.overlay_mode == OverlayMode::Menu) {
            key_hint(canvas, x, y + 2, "UP/DN", "Move", palette);
            key_hint(canvas, x, y + 2, "ENT", "Choose", palette);
            key_hint(canvas, x, y + 2, "ESC", "Close", palette);
        } else if (ui.overlay_mode == OverlayMode::Confirmation) {
            key_hint(canvas, x, y + 2, "ESC", "Cancel", palette);
            key_hint(canvas, x, y + 2, "ENT", "Confirm", palette);
        } else if (ui.overlay_mode == OverlayMode::Alert) {
            key_hint(canvas, x, y + 2, "ENT", "Mark read", palette);
            key_hint(canvas, x, y + 2, "ESC", "Close", palette);
        } else {
            key_hint(canvas, x, y + 2, "ESC", "Close", palette);
        }
        return;
    }

    switch (ui.view) {
        case View::Dashboard:
            if (state.notifications().unread_count > 0) {
                key_hint(canvas, x, y + 2, "ENT", "Alerts", palette);
            } else {
                // How old the numbers above are — the one thing Home cannot otherwise tell you, and the
                // only reason to trust or distrust what it shows. This slot used to carry operation
                // results ("App stopped", "Alerts marked read"), which restated what the operator had
                // just done and what the state already showed. Failures now open an overlay instead,
                // so they are visible from every view rather than only this one.
                char age[40];
                format_sync_age(state, ui.now_ms, age, sizeof(age));
                canvas.text(5, y + 4, age, palette.muted, palette.panel_raised);
            }
            break;
        case View::Apps:
            key_hint(canvas, x, y + 2, "UP/DN", "Select", palette);
            key_hint(canvas, x, y + 2, "ENT", "Actions", palette);
            break;
        case View::Updates:
            key_hint(canvas, x, y + 2, "ENT", "Actions", palette);
            break;
        case View::Device:
            key_hint(canvas, x, y + 2, "UP/DN", "Select", palette);
            switch (static_cast<DeviceItem>(ui.selected_device)) {
                case DeviceItem::Setup:
                case DeviceItem::CoreActions:
                case DeviceItem::DeviceActions:
                    key_hint(canvas, x, y + 2, "ENT", "Open", palette);
                    break;
                case DeviceItem::MotionWake:
                case DeviceItem::Sound:
                case DeviceItem::QuietHours:
                    key_hint(canvas, x, y + 2, "ENT", "Toggle", palette);
                    break;
                default:
                    key_hint(canvas, x, y + 2, "ENT", "Next", palette);
                    break;
            }
            break;
    }
}

void Renderer::overlay(Canvas& canvas, const UiState& ui, const ThemePalette& palette) const {
    canvas.fill_rect(8, 19, canvas.width() - 16, canvas.height() - 38, palette.panel_raised);
    canvas.fill_rect(8, 19, canvas.width() - 16, 2, palette.accent);
    canvas.text(14, 27, ui.overlay_title.view(), palette.text, palette.panel_raised);

    if (ui.overlay_mode == OverlayMode::Menu) {
        const std::size_t start = std::min<std::size_t>(ui.menu_scroll, ui.menu_items.size());
        for (std::size_t row = 0; row < kVisibleMenuItems && start + row < ui.menu_items.size(); ++row) {
            const std::size_t index = start + row;
            const bool selected = index == ui.selected_menu_item;
            const int y = 42 + static_cast<int>(row) * 14;
            const Color background = selected ? palette.panel : palette.panel_raised;
            if (selected) {
                canvas.fill_rect(11, y - 2, canvas.width() - 22, 14, background);
                canvas.fill_rect(11, y - 2, 3, 14, palette.accent);
            }
            char label[40];
            if (ui.menu_items[index].shortcut != 0) {
                std::snprintf(label, sizeof(label), "[%c] %s", ui.menu_items[index].shortcut,
                              ui.menu_items[index].label.c_str());
            } else {
                std::snprintf(label, sizeof(label), "%s", ui.menu_items[index].label.c_str());
            }
            canvas.text(18, y, label, selected ? palette.text : palette.muted, background);
        }
        return;
    }

    std::size_t offset = 0;
    int y = 43;
    while (offset < ui.overlay_body.size() && y < canvas.height() - 29) {
        const auto remaining = ui.overlay_body.view().substr(offset);
        std::size_t length = remaining.find('\n');
        if (length == std::string_view::npos || length > 34) length = 34;
        canvas.text(14, y, remaining.substr(0, length), palette.muted, palette.panel_raised);
        offset += length;
        if (offset < ui.overlay_body.size() && ui.overlay_body.view()[offset] == '\n') ++offset;
        y += 12;
    }
}

void Renderer::dashboard(Canvas& canvas, const ClientState& state, const UiState&,
                         const ThemePalette& palette) const {
    const auto counts = count_dashboard(state.core());
    char line[96];
    std::snprintf(line, sizeof(line), "Core %s", state.core().version.c_str());
    canvas.text(7, 26, line, palette.text, palette.background);
    if (state.core().core_update.available) {
        canvas.text(168, 26, "Update [U]", palette.warning, palette.background);
    }

    canvas.fill_rect(5, 42, 111, 31, palette.panel);
    canvas.text(10, 48, "RUNNING", palette.muted, palette.panel);
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.running));
    canvas.text(86, 48, line, palette.success, palette.panel);
    canvas.text(10, 61, "BUSY", palette.muted, palette.panel);
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.busy));
    canvas.text(86, 61, line, palette.warning, palette.panel);

    canvas.fill_rect(123, 42, 112, 31, palette.panel);
    canvas.text(128, 48, "FAILED", palette.muted, palette.panel);
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.failed));
    canvas.text(205, 48, line, counts.failed ? palette.error : palette.success, palette.panel);
    canvas.text(128, 61, "STOPPED", palette.muted, palette.panel);
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.stopped));
    canvas.text(205, 61, line, palette.text, palette.panel);

    canvas.fill_rect(5, 80, 230, 29, palette.panel);
    std::snprintf(line, sizeof(line), "Updates %u  Review %u  Alerts %u",
                  static_cast<unsigned>(counts.updates), static_cast<unsigned>(counts.review_updates),
                  static_cast<unsigned>(state.notifications().unread_count));
    canvas.text(10, 87, line, counts.review_updates ? palette.warning : palette.text, palette.panel);
}

void Renderer::apps(Canvas& canvas, const ClientState& state, const UiState& ui,
                    const ThemePalette& palette) const {
    const auto& list = state.core().apps;
    if (list.empty()) {
        canvas.text(8, 35, state.synchronized() ? "No installed apps" : "Waiting for Core...",
                    palette.muted, palette.background);
        return;
    }

    const std::size_t start = ui.app_scroll < list.size() ? ui.app_scroll : 0;
    for (std::size_t row = 0; row < 5 && start + row < list.size(); ++row) {
        const std::size_t index = start + row;
        const auto& app = list[index];
        const int y = 21 + static_cast<int>(row) * 19;
        const bool selected = index == ui.selected_app;
        const Color background = selected ? palette.panel_raised : palette.background;
        if (selected) canvas.fill_rect(3, y, 234, 18, background);
        canvas.fill_rect(6, y + 5, 5, 8, state_color(app.runtime_state, palette));
        canvas.text(15, y + 3, app.display_name.view(), palette.text, background);
        canvas.text(154, y + 3, runtime_state_label(app.runtime_state), state_color(app.runtime_state, palette), background);
        if (app.update.available) canvas.text(219, y + 3, app.update.requires_review ? "R" : "U", palette.warning, background);
    }
}

void Renderer::updates(Canvas& canvas, const ClientState& state, const UiState&,
                       const ThemePalette& palette) const {
    int y = 24;
    std::uint16_t shown = 0;
    for (const auto& app : state.core().apps) {
        if (!app.update.available) continue;
        const Color color = app.update.requires_review || app.update.plan_digest.empty() ? palette.warning : palette.accent;
        canvas.text(7, y, app.display_name.view(), palette.text, palette.background);
        canvas.text(160, y, app.update.requires_review ? "Shell review" : "Ready", color, palette.background);
        y += 17;
        if (++shown == 5) break;
    }
    if (shown == 0) {
        canvas.text(8, 35, state.core().update_check.running ? "Checking updates..." : "No routine updates",
                    palette.muted, palette.background);
    }
}

void Renderer::device(Canvas& canvas, const ClientState&, const UiState& ui,
                      const ThemePalette& palette) const {
    char line[96];
    std::snprintf(line, sizeof(line), "Firmware %s", ui.firmware_version.c_str());
    canvas.text(7, 23, line, palette.muted, palette.background);

    const std::uint8_t item_count = static_cast<std::uint8_t>(DeviceItem::Count);
    const std::uint8_t start = std::min(ui.device_scroll, static_cast<std::uint8_t>(item_count - 1));
    for (std::uint8_t row = 0; row < kVisibleDeviceItems && start + row < item_count; ++row) {
        const auto index = static_cast<std::uint8_t>(start + row);
        const auto item = static_cast<DeviceItem>(index);
        const int y = 35 + static_cast<int>(row) * 16;
        const bool selected = index == ui.selected_device;
        const Color background = selected ? palette.panel_raised : palette.background;
        if (selected) {
            canvas.fill_rect(3, y - 2, 234, 15, background);
            canvas.fill_rect(3, y - 2, 3, 15, palette.accent);
        }
        canvas.text(9, y, device_label(item), selected ? palette.text : palette.muted, background);

        char value[24]{};
        switch (item) {
            case DeviceItem::StandbyMode: std::snprintf(value, sizeof(value), "%s", ui.eco_standby ? "Eco" : "Live"); break;
            case DeviceItem::ScreenTimeout: format_duration(value, sizeof(value), ui.display_timeout_ms); break;
            case DeviceItem::AlertInterval: format_duration(value, sizeof(value), ui.alert_interval_ms); break;
            case DeviceItem::MotionWake: std::snprintf(value, sizeof(value), "%s", ui.motion_wake ? "On" : "Off"); break;
            case DeviceItem::Theme: std::snprintf(value, sizeof(value), "%s", theme_name(ui.theme).data()); break;
            case DeviceItem::Sound: std::snprintf(value, sizeof(value), "%s", ui.sound_enabled ? "On" : "Off"); break;
            case DeviceItem::QuietHours: std::snprintf(value, sizeof(value), "%s", ui.quiet_hours_enabled ? "On" : "Off"); break;
            case DeviceItem::Setup:
            case DeviceItem::CoreActions:
            case DeviceItem::DeviceActions: std::snprintf(value, sizeof(value), ">"); break;
            case DeviceItem::Count: break;
        }
        const int value_x = canvas.width() - static_cast<int>(std::char_traits<char>::length(value)) * 6 - 8;
        canvas.text(value_x, y, value, selected ? palette.accent : palette.text, background);
    }
}

}  // namespace hosty
