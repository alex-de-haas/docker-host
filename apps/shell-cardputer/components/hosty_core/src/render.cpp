#include "hosty/render.hpp"

#include <algorithm>
#include <cstdio>

namespace hosty {
namespace {

constexpr int kHeaderHeight = 18;
constexpr int kFooterHeight = 15;
constexpr int kVisibleDeviceItems = 6;
constexpr int kVisibleMenuItems = 5;

constexpr ThemePalette kAmber{
    0x0000, 0x2104, 0x4208, 0xFFFF, 0x9495, 0xFDA0, 0x56B7, 0xFDA0, 0xFA4A, 0x4208,
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
        case ConnectionState::Online: return "Hosty";
        case ConnectionState::Stale: return "Retry [R]";
        case ConnectionState::Unauthorized: return "Revoked";
        case ConnectionState::UnsupportedCore: return "Upgrade Core";
        case ConnectionState::Offline: return "Offline";
    }
    return "Unknown";
}

Color connection_color(ConnectionState state, const ThemePalette& palette) {
    switch (state) {
        case ConnectionState::Online: return palette.muted;
        case ConnectionState::Stale: return palette.error;
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
    if (state.core().received_at_ms == 0 || state.last_sync_ms() == 0 || now_ms < state.last_sync_ms()) {
        std::snprintf(output, size, "Waiting for Core");
        return;
    }

    const std::uint64_t age_seconds = (now_ms - state.last_sync_ms()) / 1000;
    if (age_seconds < 10) {
        std::snprintf(output, size, "Checked now");
    } else if (age_seconds < 60) {
        std::snprintf(output, size, "Checked %us ago", static_cast<unsigned>(age_seconds));
    } else if (age_seconds < 3600) {
        std::snprintf(output, size, "Checked %um ago", static_cast<unsigned>(age_seconds / 60));
    } else {
        std::snprintf(output, size, "Checked %uh ago", static_cast<unsigned>(age_seconds / 3600));
    }
}

std::string_view device_label(DeviceItem item) {
    switch (item) {
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
    const bool starting = ui.view == View::Dashboard && state.core().received_at_ms == 0;
    const std::string_view status = starting ? "Hosty" : header_status(state.connection());
    canvas.text(5, 5, status, starting ? palette.muted : connection_color(state.connection(), palette), palette.panel_raised);

    char page[20];
    std::snprintf(page, sizeof(page), starting ? "%s" : "< %s >", starting ? "Startup" : view_name(ui.view).data());
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
        case View::Dashboard: {
            if (state.core().received_at_ms == 0) {
                canvas.text(8, y + 4, "Status appears as soon as it is ready", palette.muted, palette.panel_raised);
                break;
            }
            key_hint(canvas, x, y + 2, "R", "Refresh", palette);
            char age[40];
            format_sync_age(state, ui.now_ms, age, sizeof(age));
            const int age_x = canvas.width() - static_cast<int>(std::char_traits<char>::length(age)) * 6 - 5;
            canvas.text(age_x, y + 4, age, palette.muted, palette.panel_raised);
            break;
        }
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
                case DeviceItem::Sound:
                case DeviceItem::QuietHours:
                    key_hint(canvas, x, y + 2, "ENT", "Toggle", palette);
                    break;
                default:
                    key_hint(canvas, x, y + 2, "ENT", "Next", palette);
                    break;
            }
            // Right-aligned so it never collides with the hints growing from the left, and dropped
            // entirely when the two would overlap on a long hint rather than drawn over it.
            if (!ui.firmware_version.empty()) {
                // firmware_version holds up to 32 characters, so the buffer is sized to take all of
                // them rather than relying on a version staying short.
                char version[40];
                std::snprintf(version, sizeof(version), "FW %s", ui.firmware_version.c_str());
                const int width = static_cast<int>(std::char_traits<char>::length(version)) * 6;
                const int version_x = canvas.width() - width - 5;
                if (version_x > x + 4) {
                    canvas.text(version_x, y + 4, version, palette.muted, palette.panel_raised);
                }
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

void Renderer::startup(Canvas& canvas, const ClientState& state, const ThemePalette& palette) const {
    const auto connection = state.connection();
    const int step = connection == ConnectionState::Connecting ? 2 :
        (connection == ConnectionState::TimeSyncing || connection == ConnectionState::Authorizing) ? 1 : 0;
    const bool failed = connection == ConnectionState::Offline || connection == ConnectionState::Unauthorized ||
        connection == ConnectionState::UnsupportedCore;
    canvas.text_scaled(8, 29, failed ? "Check interrupted" : "Starting up", palette.text, palette.background, 2);
    constexpr std::string_view detail[] = {"Connecting to Wi-Fi", "Connecting to Core", "Reading app status"};
    const std::string_view message = connection == ConnectionState::Offline ? "Connection failed; press R to retry" :
        connection == ConnectionState::Unauthorized ? "Device approval required" :
        connection == ConnectionState::UnsupportedCore ? "Core needs an update" : detail[step];
    canvas.text(8, 54, message, failed ? palette.error : palette.muted, palette.background);
    constexpr std::string_view labels[] = {"Wi-Fi", "Core", "Apps"};
    for (int index = 0; index < 3; ++index) {
        const int x = 8 + index * 77;
        const Color color = failed ? palette.border : index < step ? palette.success :
            index == step ? palette.accent : palette.border;
        canvas.fill_rect(x, 81, 69, 3, color);
        canvas.text(x, 94, labels[index], index == step ? palette.text : palette.muted, palette.background);
    }
}

namespace {

std::string_view attention_reason(const AppSummary& app) {
    if (app.configuration_required) return "setup needed";
    if (app.permission_error || (app.permissions_known && app.missing_permissions)) return "permissions";
    if (app.restart_required) return "restart needed";
    if (app.update.has_error || app.update_needs_attention) return "update problem";
    if (app.runtime_state == RuntimeState::Failed || app.operation_state == OperationState::Failed || !app.last_error.empty())
        return "error reported";
    if (app.health_degraded) return "unhealthy";
    return "status unknown";
}

// Reserve room for the reason, even when an app has a long display name.
void problem_detail(char* output, std::size_t size, const AppSummary& app) {
    const auto reason = attention_reason(app);
    const auto name = app.display_name.empty() ? app.id.view() : app.display_name.view();
    const std::size_t maximum_name = 37 - reason.size() - 2;
    const bool truncate = name.size() > maximum_name;
    std::snprintf(output, size, "%.*s%s: %.*s", static_cast<int>(truncate ? maximum_name - 3 : name.size()),
                  name.data(), truncate ? "..." : "", static_cast<int>(reason.size()), reason.data());
}

}  // namespace

void Renderer::dashboard(Canvas& canvas, const ClientState& state, const UiState& ui,
                         const ThemePalette& palette) const {
    if (state.core().received_at_ms == 0) {
        startup(canvas, state, palette);
        return;
    }
    const auto counts = count_dashboard(state.core());
    const auto connection = state.connection();
    const auto& core_update = state.core().core_update;
    const auto unread = state.notifications().unread_count;
    std::string_view title = "All clear";
    Color outcome_color = palette.text;
    char detail[96] = "No apps need attention";
    if (connection == ConnectionState::Offline || connection == ConnectionState::Stale ||
        connection == ConnectionState::Unauthorized || connection == ConnectionState::UnsupportedCore) {
        title = connection == ConnectionState::Offline ? "Wi-Fi offline" :
            connection == ConnectionState::Unauthorized ? "Access revoked" :
            connection == ConnectionState::UnsupportedCore ? "Update Core" : "Check failed";
        outcome_color = palette.error;
        std::snprintf(detail, sizeof(detail), "Showing the last app check");
    } else if (counts.attention != 0) {
        title = "Needs attention";
        outcome_color = palette.error;
        for (const auto& app : state.core().apps) {
            if (needs_attention(app)) { problem_detail(detail, sizeof(detail), app); break; }
        }
    } else if (connection != ConnectionState::Online || !ui.alerts_loaded ||
               (!core_update.known && core_update.error.empty())) {
        title = "Checking status";
        std::snprintf(detail, sizeof(detail), "App status ready; finishing checks");
    } else if (!core_update.error.empty()) {
        title = "Check incomplete";
        outcome_color = palette.warning;
        std::snprintf(detail, sizeof(detail), "Core update status unavailable");
    } else if (counts.busy != 0) {
        title = "Apps are busy";
        std::snprintf(detail, sizeof(detail), "An app operation is in progress");
    } else if (unread != 0) {
        title = "New alerts";
        std::snprintf(detail, sizeof(detail), "Press Enter to read the latest alert");
    } else if (state.core().apps.empty()) {
        title = "No apps installed";
        std::snprintf(detail, sizeof(detail), "Core is available");
    }
    canvas.text_scaled(8, 24, title, outcome_color, palette.background, 2);
    canvas.text(8, 45, detail, palette.muted, palette.background);

    char line[96];
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.attention));
    canvas.text_scaled(8, 62, line, counts.attention ? palette.error : palette.muted, palette.background, 3);
    canvas.text(50, 62, "Attention", palette.text, palette.background);
    std::snprintf(line, sizeof(line), "of %u apps", static_cast<unsigned>(state.core().apps.size()));
    canvas.text(50, 77, line, palette.muted, palette.background);
    canvas.fill_rect(118, 62, 1, 23, palette.border);
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.updates));
    canvas.text_scaled(128, 62, line, counts.updates ? palette.accent : palette.muted, palette.background, 3);
    canvas.text(170, 62, "Updates", palette.text, palette.background);
    std::snprintf(line, sizeof(line), "%u review", static_cast<unsigned>(counts.review_updates));
    canvas.text(170, 77, line, palette.muted, palette.background);

    std::snprintf(line, sizeof(line), "%u running  %u busy  %u stopped", static_cast<unsigned>(counts.running),
                  static_cast<unsigned>(counts.busy), static_cast<unsigned>(counts.stopped));
    canvas.text(8, 96, line, palette.muted, palette.background);
    if (!ui.alerts_loaded) std::snprintf(line, sizeof(line), "Alerts ...");
    else if (unread > 999) std::snprintf(line, sizeof(line), "Alerts 999+ [ENT]");
    else std::snprintf(line, sizeof(line), "Alerts %lu%s", static_cast<unsigned long>(unread), unread ? " [ENT]" : "");
    canvas.text(8, 108, line, unread && ui.alerts_loaded ? palette.accent : palette.muted, palette.background);
    const std::string_view update = core_update.available ? "Core update [U]" : !core_update.error.empty() ?
        "Core check failed" : !core_update.known ? "Core ..." : "";
    const int update_x = canvas.width() - static_cast<int>(update.size()) * 6 - 8;
    canvas.text(update_x, 108, update, core_update.available ? palette.accent : palette.muted, palette.background);
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
        canvas.fill_rect(6, y + 5, 5, 8, needs_attention(app) ? palette.error : state_color(app.runtime_state, palette));
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

void Renderer::device(Canvas& canvas, const ClientState& state, const UiState& ui,
                      const ThemePalette& palette) const {
    char core_version[40];
    std::snprintf(core_version, sizeof(core_version), "Core %s", state.core().version.empty() ? "unknown" : state.core().version.c_str());
    canvas.text(8, 24, core_version, palette.muted, palette.background);
    const std::uint8_t item_count = static_cast<std::uint8_t>(DeviceItem::Count);
    const std::uint8_t start = std::min(ui.device_scroll, static_cast<std::uint8_t>(item_count - 1));
    for (std::uint8_t row = 0; row < kVisibleDeviceItems && start + row < item_count; ++row) {
        const auto index = static_cast<std::uint8_t>(start + row);
        const auto item = static_cast<DeviceItem>(index);
        const int y = 40 + static_cast<int>(row) * 13;
        const bool selected = index == ui.selected_device;
        const Color background = selected ? palette.panel_raised : palette.background;
        if (selected) {
            canvas.fill_rect(3, y - 2, 234, 13, background);
            canvas.fill_rect(3, y - 2, 3, 13, palette.accent);
        }
        canvas.text(9, y, device_label(item), selected ? palette.text : palette.muted, background);

        char value[24]{};
        switch (item) {
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
