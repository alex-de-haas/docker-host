#include "hosty/power.hpp"

namespace hosty {

PowerAction PowerController::tick(std::uint64_t now_ms, bool keyboard_activity, std::uint16_t motion_delta_mg) {
    PowerAction action;
    if (mode_ == PowerMode::DeepStandby) {
        if (keyboard_activity) return leave_deep_standby(now_ms);
        return action;
    }

    const bool motion = policy_.motion_wake && motion_delta_mg >= policy_.motion_threshold_mg &&
                        now_ms >= motion_cooldown_until_ms_;
    if (keyboard_activity || motion) {
        note_interaction(now_ms);
        if (motion) motion_cooldown_until_ms_ = now_ms + policy_.motion_cooldown_ms;
        if (mode_ == PowerMode::OnlineStandby) {
            mode_ = PowerMode::Active;
            action.display_on = true;
        }
        return action;
    }

    if (mode_ == PowerMode::Active && now_ms >= last_interaction_ms_ &&
        now_ms - last_interaction_ms_ >= policy_.display_timeout_ms) {
        mode_ = PowerMode::OnlineStandby;
        action.display_off = true;
    }
    return action;
}

PowerAction PowerController::notification(std::uint64_t now_ms, NotificationLevel level, bool quiet_hours) {
    PowerAction action;
    action.play_sound = !quiet_hours;
    const bool wake = (level == NotificationLevel::Error && policy_.wake_display_for_error) ||
                      (level == NotificationLevel::Warning && policy_.wake_display_for_warning);
    if (wake && mode_ == PowerMode::OnlineStandby) {
        mode_ = PowerMode::Active;
        note_interaction(now_ms);
        action.display_on = true;
    }
    return action;
}

PowerAction PowerController::request_deep_standby() {
    PowerAction action;
    if (mode_ != PowerMode::DeepStandby) {
        mode_ = PowerMode::DeepStandby;
        action.display_off = true;
        action.enter_deep_sleep = true;
    }
    return action;
}

PowerAction PowerController::leave_deep_standby(std::uint64_t now_ms) {
    PowerAction action;
    if (mode_ == PowerMode::DeepStandby) {
        mode_ = PowerMode::Active;
        note_interaction(now_ms);
        action.leave_deep_sleep = true;
        action.display_on = true;
    }
    return action;
}

void PowerController::note_interaction(std::uint64_t now_ms) { last_interaction_ms_ = now_ms; }

}  // namespace hosty

