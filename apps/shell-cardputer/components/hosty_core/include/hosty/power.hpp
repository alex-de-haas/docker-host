#pragma once

#include "hosty/model.hpp"

#include <cstdint>

namespace hosty {

enum class PowerMode : std::uint8_t { Active, OnlineStandby, DeepStandby };

struct PowerPolicy {
    std::uint32_t display_timeout_ms = 30'000;
    std::uint32_t motion_cooldown_ms = 3'000;
    std::uint16_t motion_threshold_mg = 180;
    bool motion_wake = true;
    bool wake_display_for_warning = false;
    bool wake_display_for_error = true;
};

struct PowerAction {
    bool display_on = false;
    bool display_off = false;
    bool enter_deep_sleep = false;
    bool leave_deep_sleep = false;
    bool play_sound = false;
};

class PowerController {
public:
    explicit PowerController(PowerPolicy policy = {}) : policy_(policy) {}

    PowerAction tick(std::uint64_t now_ms, bool keyboard_activity, std::uint16_t motion_delta_mg);
    PowerAction notification(std::uint64_t now_ms, NotificationLevel level, bool quiet_hours);
    PowerAction request_deep_standby();
    PowerAction leave_deep_standby(std::uint64_t now_ms);
    void set_policy(const PowerPolicy& policy) { policy_ = policy; }

    [[nodiscard]] PowerMode mode() const { return mode_; }
    [[nodiscard]] std::uint64_t last_interaction_ms() const { return last_interaction_ms_; }

private:
    void note_interaction(std::uint64_t now_ms);

    PowerPolicy policy_;
    PowerMode mode_ = PowerMode::Active;
    std::uint64_t last_interaction_ms_ = 0;
    std::uint64_t motion_cooldown_until_ms_ = 0;
};

}  // namespace hosty

