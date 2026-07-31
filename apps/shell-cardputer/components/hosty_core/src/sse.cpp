#include "hosty/sse.hpp"

namespace hosty {

SseError SseParser::feed(std::string_view bytes) {
    if (error_ != SseError::None) return error_;
    for (const char character : bytes) {
        if (character == '\r') {
            if (!finish_line()) break;
            saw_cr_ = true;
            continue;
        }
        if (character == '\n') {
            if (saw_cr_) {
                saw_cr_ = false;
                continue;
            }
            if (!finish_line()) break;
            continue;
        }
        saw_cr_ = false;
        if (!line_.append(character)) {
            error_ = SseError::LineTooLong;
            break;
        }
    }
    return error_;
}

SseError SseParser::finish() {
    if (error_ != SseError::None) return error_;
    if (!line_.empty() && !finish_line()) return error_;
    if (!data_.empty() && !dispatch()) return error_;
    return error_;
}

void SseParser::reset() {
    line_.clear();
    event_name_.clear();
    data_.clear();
    saw_cr_ = false;
    error_ = SseError::None;
}

bool SseParser::finish_line() {
    const auto line = line_.view();
    if (line.empty()) {
        line_.clear();
        return dispatch();
    }
    if (line.front() == ':') {
        line_.clear();
        return true;
    }

    const std::size_t separator = line.find(':');
    const std::string_view field = separator == std::string_view::npos ? line : line.substr(0, separator);
    std::string_view value = separator == std::string_view::npos ? std::string_view{} : line.substr(separator + 1);
    if (!value.empty() && value.front() == ' ') value.remove_prefix(1);

    if (field == "event") {
        if (!event_name_.assign(value)) {
            error_ = SseError::LineTooLong;
            return false;
        }
    } else if (field == "data") {
        if (!data_.empty() && !data_.append('\n')) {
            error_ = SseError::EventTooLarge;
            return false;
        }
        if (!data_.append(value)) {
            error_ = SseError::EventTooLarge;
            return false;
        }
    }
    line_.clear();
    return true;
}

bool SseParser::dispatch() {
    if (data_.empty()) {
        event_name_.clear();
        return true;
    }
    const std::string_view name = event_name_.empty() ? std::string_view{"message"} : event_name_.view();
    if (!listener_.on_sse_event(SseEvent{name, data_.view()})) {
        error_ = SseError::ListenerRejected;
        return false;
    }
    event_name_.clear();
    data_.clear();
    return true;
}

const char* sse_error_name(SseError error) {
    switch (error) {
        case SseError::None: return "none";
        case SseError::LineTooLong: return "line_too_long";
        case SseError::EventTooLarge: return "event_too_large";
        case SseError::ListenerRejected: return "listener_rejected";
    }
    return "unknown";
}

}  // namespace hosty

