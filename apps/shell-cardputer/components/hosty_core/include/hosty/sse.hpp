#pragma once

#include "hosty/bounded.hpp"

#include <cstdint>
#include <string_view>

namespace hosty {

struct SseEvent {
    std::string_view name;
    std::string_view data;
};

class SseListener {
public:
    virtual ~SseListener() = default;
    virtual bool on_sse_event(const SseEvent& event) = 0;
};

enum class SseError : std::uint8_t { None, LineTooLong, EventTooLarge, ListenerRejected };

class SseParser {
public:
    explicit SseParser(SseListener& listener) : listener_(listener) {}

    SseError feed(std::string_view bytes);
    SseError finish();
    void reset();
    [[nodiscard]] SseError error() const { return error_; }

private:
    bool finish_line();
    bool dispatch();

    SseListener& listener_;
    FixedString<1024> line_;
    FixedString<48> event_name_;
    FixedString<3072> data_;
    bool saw_cr_ = false;
    SseError error_ = SseError::None;
};

[[nodiscard]] const char* sse_error_name(SseError error);

}  // namespace hosty

