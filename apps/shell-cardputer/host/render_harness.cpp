#include "hosty/render.hpp"
#include "hosty/state.hpp"
#include "ppm_canvas.hpp"

#include <cstdio>
#include <filesystem>
#include <iostream>
#include <utility>

#ifndef HOSTY_CARDPUTER_VERSION
#define HOSTY_CARDPUTER_VERSION "development"
#endif

int main(int argc, char** argv) {
    const std::filesystem::path output = argc > 1 ? argv[1] : "build-host/render";
    std::filesystem::create_directories(output);

    hosty::CoreSnapshot core;
    core.version.assign_truncated("0.73.0");
    for (int index = 0; index < 8; ++index) {
        hosty::AppSummary app;
        char id[32];
        char name[32];
        std::snprintf(id, sizeof(id), "com.haas.service-%d", index + 1);
        std::snprintf(name, sizeof(name), index == 0 ? "Hosty Shell" : "Service %d", index + 1);
        app.id.assign_truncated(id);
        app.display_name.assign_truncated(name);
        app.version.assign_truncated("1.4.2");
        app.runtime_state = index == 2 ? hosty::RuntimeState::Failed : index == 3 ? hosty::RuntimeState::Stopped : hosty::RuntimeState::Running;
        app.operation_state = index == 5 ? hosty::OperationState::Updating : hosty::OperationState::Idle;
        app.update.checked = true;
        app.update.available = index == 1 || index == 4;
        app.update.requires_review = index == 4;
        if (index == 1) app.update.plan_digest.assign_truncated("sha256:routine");
        static_cast<void>(core.apps.push_back(app));
    }
    hosty::NotificationSnapshot notifications;
    notifications.unread_count = 3;

    hosty::ClientState state;
    state.install_snapshot(core, 1000);
    state.install_notifications(notifications);
    state.apply({hosty::ConnectionEvent::Type::SyncCompleted, 1000});

    hosty::UiState ui;
    ui.battery_percent = 78;
    ui.firmware_version.assign_truncated(HOSTY_CARDPUTER_VERSION);
    ui.device_label.assign_truncated("Pocket admin");
    ui.endpoint.assign_truncated("https://hosty.example");
    ui.status_message.assign_truncated("All systems synchronized");

    hosty::Renderer renderer;
    for (int index = 0; index < 4; ++index) {
        ui.view = static_cast<hosty::View>(index);
        hosty::host::PpmCanvas canvas;
        renderer.render(canvas, state, ui);
        const auto path = output / (std::string(index == 0 ? "dashboard" : index == 1 ? "apps" : index == 2 ? "updates" : "device") + ".ppm");
        if (!canvas.write(path.string())) {
            std::cerr << "Could not write " << path << '\n';
            return 1;
        }
        std::cout << path.string() << " " << canvas.checksum() << '\n';
    }

    ui.view = hosty::View::Dashboard;
    for (const auto theme : {hosty::ColorTheme::Ocean, hosty::ColorTheme::Violet}) {
        ui.theme = theme;
        hosty::host::PpmCanvas canvas;
        renderer.render(canvas, state, ui);
        const auto path = output / (std::string("dashboard-") +
            (theme == hosty::ColorTheme::Ocean ? "ocean" : "violet") + ".ppm");
        if (!canvas.write(path.string())) {
            std::cerr << "Could not write " << path << '\n';
            return 1;
        }
        std::cout << path.string() << " " << canvas.checksum() << '\n';
    }

    // The settled Home footer: no unread alerts and no recent operation, which is what the operator
    // sees most of the time. It reports how old the numbers above it are rather than restating the
    // header, so a snapshot that stopped updating is visible instead of silently looking current.
    hosty::ClientState idle_state;
    hosty::CoreSnapshot idle_core = core;
    hosty::NotificationSnapshot read_notifications = notifications;
    read_notifications.unread_count = 0;
    idle_state.install_snapshot(idle_core, 1000);
    idle_state.install_notifications(read_notifications);
    idle_state.apply({hosty::ConnectionEvent::Type::SyncCompleted, 1000});
    hosty::UiState idle_ui = ui;
    idle_ui.theme = hosty::ColorTheme::Amber;
    idle_ui.status_message.clear();
    idle_ui.now_ms = 46'000;  // 45 s after the snapshot above.
    hosty::host::PpmCanvas idle_canvas;
    renderer.render(idle_canvas, idle_state, idle_ui);
    const auto idle_path = output / "dashboard-idle.ppm";
    if (!idle_canvas.write(idle_path.string())) {
        std::cerr << "Could not write " << idle_path << '\n';
        return 1;
    }
    std::cout << idle_path.string() << " " << idle_canvas.checksum() << '\n';

    hosty::CoreSnapshot core_update = core;
    core_update.core_update.known = true;
    core_update.core_update.available = true;
    hosty::ClientState update_state;
    update_state.install_snapshot(core_update, 1000);
    update_state.install_notifications(notifications);
    update_state.apply({hosty::ConnectionEvent::Type::SyncCompleted, 1000});
    ui.theme = hosty::ColorTheme::Amber;
    hosty::host::PpmCanvas update_canvas;
    renderer.render(update_canvas, update_state, ui);
    const auto update_path = output / "dashboard-core-update.ppm";
    if (!update_canvas.write(update_path.string())) {
        std::cerr << "Could not write " << update_path << '\n';
        return 1;
    }
    std::cout << update_path.string() << " " << update_canvas.checksum() << '\n';

    ui.view = hosty::View::Apps;
    ui.overlay_visible = true;
    ui.overlay_mode = hosty::OverlayMode::Menu;
    ui.overlay_title.assign_truncated("Service 1");
    for (const auto [shortcut, label] : {
             std::pair{'S', "Stop"}, std::pair{'R', "Restart"},
             std::pair{'A', "Enable autostart"}, std::pair{'U', "Apply update"}}) {
        hosty::MenuItem item;
        item.shortcut = shortcut;
        item.label.assign_truncated(label);
        static_cast<void>(ui.menu_items.push_back(item));
    }
    hosty::host::PpmCanvas menu_canvas;
    renderer.render(menu_canvas, state, ui);
    const auto menu_path = output / "app-actions.ppm";
    if (!menu_canvas.write(menu_path.string())) {
        std::cerr << "Could not write " << menu_path << '\n';
        return 1;
    }
    std::cout << menu_path.string() << " " << menu_canvas.checksum() << '\n';
    return 0;
}
