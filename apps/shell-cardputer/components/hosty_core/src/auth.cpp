#include "hosty/auth.hpp"

namespace hosty {

void Enrollment::start(std::uint64_t now_ms) {
    reset();
    state_ = EnrollmentState::RequestingCode;
    next_poll_at_ms_ = now_ms;
}

bool Enrollment::accept_code(const DeviceCode& code, std::uint64_t now_ms) {
    if (state_ != EnrollmentState::RequestingCode || code.device_code.empty() || code.user_code.empty() ||
        code.expires_in_seconds == 0) {
        state_ = EnrollmentState::Error;
        return false;
    }
    code_ = code;
    const std::uint64_t lifetime_ms = static_cast<std::uint64_t>(code.expires_in_seconds) * 1000U;
    expires_at_ms_ = now_ms + lifetime_ms;
    next_poll_at_ms_ = now_ms + static_cast<std::uint64_t>(code.interval_seconds) * 1000U;
    state_ = EnrollmentState::WaitingForApproval;
    return true;
}

void Enrollment::accept_token_result(const DeviceTokenResult& result, std::uint64_t now_ms) {
    if (state_ != EnrollmentState::WaitingForApproval) return;
    switch (result.status) {
        case DeviceTokenStatus::Pending:
            mark_polled(now_ms);
            break;
        case DeviceTokenStatus::Approved:
            if (result.token.empty()) state_ = EnrollmentState::Error;
            else {
                token_ = result.token;
                state_ = EnrollmentState::Approved;
            }
            break;
        case DeviceTokenStatus::Denied:
            state_ = EnrollmentState::Denied;
            break;
        case DeviceTokenStatus::Expired:
            state_ = EnrollmentState::Expired;
            break;
        case DeviceTokenStatus::Unknown:
            state_ = EnrollmentState::Error;
            break;
    }
}

void Enrollment::fail() { state_ = EnrollmentState::Error; }

void Enrollment::reset() {
    state_ = EnrollmentState::Idle;
    code_ = {};
    token_.clear();
    expires_at_ms_ = 0;
    next_poll_at_ms_ = 0;
}

bool Enrollment::poll_due(std::uint64_t now_ms) const {
    return state_ == EnrollmentState::WaitingForApproval && now_ms < expires_at_ms_ && now_ms >= next_poll_at_ms_;
}

void Enrollment::mark_polled(std::uint64_t now_ms) {
    if (state_ != EnrollmentState::WaitingForApproval) return;
    if (now_ms >= expires_at_ms_) {
        state_ = EnrollmentState::Expired;
        return;
    }
    next_poll_at_ms_ = now_ms + static_cast<std::uint64_t>(code_.interval_seconds) * 1000U;
}

std::uint32_t Enrollment::remaining_seconds(std::uint64_t now_ms) const {
    if (state_ != EnrollmentState::WaitingForApproval || now_ms >= expires_at_ms_) return 0;
    return static_cast<std::uint32_t>((expires_at_ms_ - now_ms + 999U) / 1000U);
}

}  // namespace hosty

