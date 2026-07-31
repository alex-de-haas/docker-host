#include "hosty/render.hpp"

#include <cstdio>

namespace hosty {
namespace {

constexpr int kHeaderHeight = 18;
constexpr int kFooterHeight = 15;

Color state_color(RuntimeState state) {
    switch (state) {
        case RuntimeState::Running: return colors::Success;
        case RuntimeState::Starting:
        case RuntimeState::Stopping: return colors::Warning;
        case RuntimeState::Failed: return colors::Error;
        case RuntimeState::Stopped:
        case RuntimeState::Unknown: return colors::Muted;
    }
    return colors::Muted;
}

std::string_view view_name(View view) {
    switch (view) {
        case View::Dashboard: return "Home";
        case View::Apps: return "Apps";
        case View::Updates: return "Updates";
        case View::Device: return "Device";
    }
    return "Hosty";
}

}  // namespace

void Renderer::render(Canvas& canvas, const ClientState& state, const UiState& ui) const {
    canvas.fill(colors::Background);
    switch (ui.view) {
        case View::Dashboard: dashboard(canvas, state, ui); break;
        case View::Apps: apps(canvas, state, ui); break;
        case View::Updates: updates(canvas, state, ui); break;
        case View::Device: device(canvas, state, ui); break;
    }
    footer(canvas, ui.view);
    if (ui.overlay_visible) overlay(canvas, ui);
}

void Renderer::overlay(Canvas& canvas, const UiState& ui) const {
    canvas.fill_rect(8, 19, canvas.width() - 16, canvas.height() - 38, colors::PanelRaised);
    canvas.fill_rect(8, 19, canvas.width() - 16, 2, colors::Accent);
    canvas.text(14, 27, ui.overlay_title.view(), colors::Text, colors::PanelRaised);

    std::size_t offset = 0;
    int y = 43;
    while (offset < ui.overlay_body.size() && y < canvas.height() - 29) {
        const auto remaining = ui.overlay_body.view().substr(offset);
        std::size_t length = remaining.find('\n');
        if (length == std::string_view::npos || length > 34) length = 34;
        canvas.text(14, y, remaining.substr(0, length), colors::Muted, colors::PanelRaised);
        offset += length;
        if (offset < ui.overlay_body.size() && ui.overlay_body.view()[offset] == '\n') ++offset;
        y += 12;
    }
}

void Renderer::header(Canvas& canvas, const ClientState& state, const UiState& ui, std::string_view title) const {
    canvas.fill_rect(0, 0, canvas.width(), kHeaderHeight, colors::PanelRaised);
    canvas.text(5, 5, title, colors::Text, colors::PanelRaised);

    char right[48];
    if (ui.battery_percent >= 0) {
        std::snprintf(right, sizeof(right), "%s %d%%%s", connection_state_label(state.connection()).data(),
                      ui.battery_percent, ui.charging ? "+" : "");
    } else {
        std::snprintf(right, sizeof(right), "%s", connection_state_label(state.connection()).data());
    }
    const int x = canvas.width() - static_cast<int>(std::char_traits<char>::length(right)) * 6 - 5;
    canvas.text(x > 80 ? x : 80, 5, right,
                state.connection() == ConnectionState::Online ? colors::Success : colors::Warning,
                colors::PanelRaised);
}

void Renderer::footer(Canvas& canvas, View selected) const {
    const int y = canvas.height() - kFooterHeight;
    canvas.fill_rect(0, y, canvas.width(), kFooterHeight, colors::PanelRaised);
    constexpr View views[] = {View::Dashboard, View::Apps, View::Updates, View::Device};
    for (int index = 0; index < 4; ++index) {
        char label[20];
        std::snprintf(label, sizeof(label), "F%d %s", index + 1, view_name(views[index]).data());
        canvas.text(4 + index * 59, y + 4, label,
                    selected == views[index] ? colors::Accent : colors::Muted, colors::PanelRaised);
    }
}

void Renderer::dashboard(Canvas& canvas, const ClientState& state, const UiState& ui) const {
    header(canvas, state, ui, "HOSTY");
    const auto counts = count_dashboard(state.core());
    char line[96];
    std::snprintf(line, sizeof(line), "Core %-10s  %s", state.core().version.c_str(),
                  state.core().core_update.available ? "update ready" : state.synchronized() ? "synced" : "waiting");
    canvas.text(7, 26, line, colors::Text, colors::Background);

    canvas.fill_rect(5, 42, 111, 31, colors::Panel);
    canvas.text(10, 48, "RUNNING", colors::Muted, colors::Panel);
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.running));
    canvas.text(86, 48, line, colors::Success, colors::Panel);
    canvas.text(10, 61, "BUSY", colors::Muted, colors::Panel);
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.busy));
    canvas.text(86, 61, line, colors::Warning, colors::Panel);

    canvas.fill_rect(123, 42, 112, 31, colors::Panel);
    canvas.text(128, 48, "FAILED", colors::Muted, colors::Panel);
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.failed));
    canvas.text(205, 48, line, counts.failed ? colors::Error : colors::Success, colors::Panel);
    canvas.text(128, 61, "STOPPED", colors::Muted, colors::Panel);
    std::snprintf(line, sizeof(line), "%u", static_cast<unsigned>(counts.stopped));
    canvas.text(205, 61, line, colors::Text, colors::Panel);

    canvas.fill_rect(5, 80, 230, 29, colors::Panel);
    std::snprintf(line, sizeof(line), "Updates %u  Review %u  Alerts %u",
                  static_cast<unsigned>(counts.updates), static_cast<unsigned>(counts.review_updates),
                  static_cast<unsigned>(state.notifications().unread_count));
    canvas.text(10, 87, line, counts.review_updates ? colors::Warning : colors::Text, colors::Panel);
    if (!ui.status_message.empty()) canvas.text(10, 99, ui.status_message.view(), colors::Muted, colors::Panel);
}

void Renderer::apps(Canvas& canvas, const ClientState& state, const UiState& ui) const {
    header(canvas, state, ui, "APPS");
    const auto& list = state.core().apps;
    if (list.empty()) {
        canvas.text(8, 35, state.synchronized() ? "No installed apps" : "Waiting for Core...", colors::Muted, colors::Background);
        return;
    }

    const std::size_t start = ui.app_scroll < list.size() ? ui.app_scroll : 0;
    for (std::size_t row = 0; row < 5 && start + row < list.size(); ++row) {
        const std::size_t index = start + row;
        const auto& app = list[index];
        const int y = 21 + static_cast<int>(row) * 19;
        const bool selected = index == ui.selected_app;
        const Color background = selected ? colors::PanelRaised : colors::Background;
        if (selected) canvas.fill_rect(3, y, 234, 18, background);
        canvas.fill_rect(6, y + 5, 5, 8, state_color(app.runtime_state));
        canvas.text(15, y + 3, app.display_name.view(), colors::Text, background);
        canvas.text(154, y + 3, runtime_state_label(app.runtime_state), state_color(app.runtime_state), background);
        if (app.update.available) canvas.text(219, y + 3, app.update.requires_review ? "R" : "U", colors::Warning, background);
    }
}

void Renderer::updates(Canvas& canvas, const ClientState& state, const UiState& ui) const {
    header(canvas, state, ui, "UPDATES");
    int y = 24;
    std::uint16_t shown = 0;
    for (const auto& app : state.core().apps) {
        if (!app.update.available) continue;
        const Color color = app.update.requires_review || app.update.plan_digest.empty() ? colors::Warning : colors::Accent;
        canvas.text(7, y, app.display_name.view(), colors::Text, colors::Background);
        canvas.text(160, y, app.update.requires_review ? "Shell review" : "Ready", color, colors::Background);
        y += 17;
        if (++shown == 5) break;
    }
    if (shown == 0) {
        canvas.text(8, 35, state.core().update_check.running ? "Checking updates..." : "No routine updates", colors::Muted,
                    colors::Background);
    }
}

void Renderer::device(Canvas& canvas, const ClientState& state, const UiState& ui) const {
    header(canvas, state, ui, "DEVICE");
    char line[128];
    std::snprintf(line, sizeof(line), "Firmware  %s", ui.firmware_version.c_str());
    canvas.text(8, 27, line, colors::Text, colors::Background);
    std::snprintf(line, sizeof(line), "Core      %s", state.core().version.c_str());
    canvas.text(8, 42, line, colors::Text, colors::Background);
    std::snprintf(line, sizeof(line), "Power     %s",
                  ui.power_mode == PowerMode::Active ? "active" :
                  ui.power_mode == PowerMode::OnlineStandby ? "online standby" : "deep standby");
    canvas.text(8, 57, line, colors::Text, colors::Background);
    canvas.text(8, 72, ui.device_label.empty() ? "Unlabeled device" : ui.device_label.view(), colors::Muted, colors::Background);
    canvas.text(8, 87, ui.endpoint.empty() ? "No Core origin" : ui.endpoint.view(), colors::Muted, colors::Background);
    canvas.text(8, 102, "Enter settings  |  Del revoke", colors::Accent, colors::Background);
}

}  // namespace hosty
