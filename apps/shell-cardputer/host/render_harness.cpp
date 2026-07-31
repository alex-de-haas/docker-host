#include "hosty/render.hpp"
#include "hosty/state.hpp"
#include "ppm_canvas.hpp"

#include <cstdio>
#include <filesystem>
#include <iostream>

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
    return 0;
}
