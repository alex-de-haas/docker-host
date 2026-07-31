#pragma once

#include "hosty/model.hpp"

#include <cstdint>

namespace hosty {

enum class EnrollmentState : std::uint8_t { Idle, RequestingCode, WaitingForApproval, Approved, Denied, Expired, Error };

class Enrollment {
public:
    void start(std::uint64_t now_ms);
    bool accept_code(const DeviceCode& code, std::uint64_t now_ms);
    void accept_token_result(const DeviceTokenResult& result, std::uint64_t now_ms);
    void fail();
    void reset();

    [[nodiscard]] bool poll_due(std::uint64_t now_ms) const;
    void mark_polled(std::uint64_t now_ms);
    [[nodiscard]] std::uint32_t remaining_seconds(std::uint64_t now_ms) const;
    [[nodiscard]] EnrollmentState state() const { return state_; }
    [[nodiscard]] const DeviceCode& code() const { return code_; }
    [[nodiscard]] const FixedString<96>& token() const { return token_; }

private:
    EnrollmentState state_ = EnrollmentState::Idle;
    DeviceCode code_;
    FixedString<96> token_;
    std::uint64_t expires_at_ms_ = 0;
    std::uint64_t next_poll_at_ms_ = 0;
};

}  // namespace hosty

