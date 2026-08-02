#include "hosty/json_stream.hpp"

#include <cctype>

namespace hosty {
namespace {

bool is_number_character(char character) {
    return (character >= '0' && character <= '9') || character == '-' || character == '+' ||
           character == '.' || character == 'e' || character == 'E';
}

bool valid_number(std::string_view value) {
    std::size_t index = 0;
    if (index < value.size() && value[index] == '-') ++index;
    if (index == value.size()) return false;
    if (value[index] == '0') {
        ++index;
        if (index < value.size() && value[index] >= '0' && value[index] <= '9') return false;
    } else {
        if (value[index] < '1' || value[index] > '9') return false;
        while (index < value.size() && value[index] >= '0' && value[index] <= '9') ++index;
    }
    if (index < value.size() && value[index] == '.') {
        ++index;
        const std::size_t fraction_start = index;
        while (index < value.size() && value[index] >= '0' && value[index] <= '9') ++index;
        if (index == fraction_start) return false;
    }
    if (index < value.size() && (value[index] == 'e' || value[index] == 'E')) {
        ++index;
        if (index < value.size() && (value[index] == '+' || value[index] == '-')) ++index;
        const std::size_t exponent_start = index;
        while (index < value.size() && value[index] >= '0' && value[index] <= '9') ++index;
        if (index == exponent_start) return false;
    }
    return index == value.size();
}

int hex_value(char character) {
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    if (character >= 'A' && character <= 'F') return character - 'A' + 10;
    return -1;
}

}  // namespace

JsonStreamParser::JsonStreamParser(JsonListener& listener) : listener_(listener) {}

void JsonStreamParser::reset() {
    depth_ = 0;
    root_complete_ = false;
    lexical_ = Lexical::Normal;
    token_.clear();
    token_truncated_ = false;
    string_is_key_ = false;
    literal_expected_.clear();
    literal_index_ = 0;
    unicode_value_ = 0;
    unicode_digits_ = 0;
    pending_high_surrogate_ = 0;
    error_ = JsonError::None;
}

JsonError JsonStreamParser::feed(std::string_view bytes) {
    if (error_ != JsonError::None) return error_;

    for (const char character : bytes) {
        bool consume = false;
        while (!consume && error_ == JsonError::None) {
            if (!process(character, consume)) break;
        }
        if (error_ != JsonError::None) break;
    }
    return error_;
}

JsonError JsonStreamParser::finish() {
    if (error_ != JsonError::None) return error_;
    if (lexical_ == Lexical::Number && !complete_number()) return error_;
    if (lexical_ != Lexical::Normal || depth_ != 0 || !root_complete_) {
        fail(JsonError::Incomplete);
    }
    return error_;
}

bool JsonStreamParser::process(char character, bool& consume) {
    switch (lexical_) {
        case Lexical::Normal:
            return process_normal(character, consume);
        case Lexical::String:
            consume = true;
            if (static_cast<unsigned char>(character) < 0x20) {
                fail(JsonError::InvalidSyntax);
                return false;
            }
            if (character == '"') return complete_string();
            if (character == '\\') {
                lexical_ = Lexical::Escape;
                return true;
            }
            return append_token(character);
        case Lexical::Escape:
            consume = true;
            lexical_ = Lexical::String;
            switch (character) {
                case '"': return append_token('"');
                case '\\': return append_token('\\');
                case '/': return append_token('/');
                case 'b': return append_token('\b');
                case 'f': return append_token('\f');
                case 'n': return append_token('\n');
                case 'r': return append_token('\r');
                case 't': return append_token('\t');
                case 'u':
                    lexical_ = Lexical::Unicode;
                    unicode_value_ = 0;
                    unicode_digits_ = 0;
                    return true;
                default:
                    fail(JsonError::InvalidSyntax);
                    return false;
            }
        case Lexical::Unicode: {
            consume = true;
            const int value = hex_value(character);
            if (value < 0) {
                fail(JsonError::InvalidSyntax);
                return false;
            }
            unicode_value_ = (unicode_value_ << 4U) | static_cast<std::uint32_t>(value);
            if (++unicode_digits_ != 4) return true;
            lexical_ = Lexical::String;

            if (unicode_value_ >= 0xD800 && unicode_value_ <= 0xDBFF) {
                if (pending_high_surrogate_ != 0 && !append_codepoint(0xFFFD)) return false;
                pending_high_surrogate_ = static_cast<std::uint16_t>(unicode_value_);
                return true;
            }
            if (unicode_value_ >= 0xDC00 && unicode_value_ <= 0xDFFF) {
                if (pending_high_surrogate_ == 0) return append_codepoint(0xFFFD);
                const std::uint32_t codepoint = 0x10000U +
                    ((static_cast<std::uint32_t>(pending_high_surrogate_) - 0xD800U) << 10U) +
                    (unicode_value_ - 0xDC00U);
                pending_high_surrogate_ = 0;
                return append_codepoint(codepoint);
            }
            if (pending_high_surrogate_ != 0) {
                pending_high_surrogate_ = 0;
                if (!append_codepoint(0xFFFD)) return false;
            }
            return append_codepoint(unicode_value_);
        }
        case Lexical::Number:
            if (is_number_character(character)) {
                consume = true;
                return append_token(character);
            }
            return complete_number();
        case Lexical::Literal:
            consume = true;
            if (literal_index_ >= literal_expected_.size() ||
                character != literal_expected_.view()[literal_index_++]) {
                fail(JsonError::InvalidSyntax);
                return false;
            }
            if (literal_index_ == literal_expected_.size()) return complete_literal();
            return true;
    }
    fail(JsonError::InvalidSyntax);
    return false;
}

bool JsonStreamParser::process_normal(char character, bool& consume) {
    if (std::isspace(static_cast<unsigned char>(character)) != 0) {
        consume = true;
        return true;
    }
    if (root_complete_ && depth_ == 0) {
        fail(JsonError::InvalidSyntax);
        return false;
    }

    consume = true;
    if (character == '{') return begin_container(Container::Object);
    if (character == '[') return begin_container(Container::Array);
    if (character == '}') return end_container(Container::Object);
    if (character == ']') return end_container(Container::Array);

    if (character == ',') {
        if (depth_ == 0) {
            fail(JsonError::InvalidSyntax);
            return false;
        }
        Frame& frame = stack_[depth_ - 1];
        if (frame.phase == Phase::ObjectCommaOrEnd) frame.phase = Phase::ObjectKey;
        else if (frame.phase == Phase::ArrayCommaOrEnd) frame.phase = Phase::ArrayValue;
        else {
            fail(JsonError::InvalidSyntax);
            return false;
        }
        return true;
    }

    if (character == ':') {
        if (depth_ == 0 || stack_[depth_ - 1].phase != Phase::ObjectColon) {
            fail(JsonError::InvalidSyntax);
            return false;
        }
        stack_[depth_ - 1].phase = Phase::ObjectValue;
        return true;
    }

    if (character == '"') return begin_string();
    if (character == '-' || (character >= '0' && character <= '9')) {
        if (!value_expected()) {
            fail(JsonError::InvalidSyntax);
            return false;
        }
        token_.clear();
        token_truncated_ = false;
        lexical_ = Lexical::Number;
        return append_token(character);
    }

    if (character == 't' || character == 'f' || character == 'n') {
        if (!value_expected()) {
            fail(JsonError::InvalidSyntax);
            return false;
        }
        literal_expected_.assign_truncated(character == 't' ? "true" : character == 'f' ? "false" : "null");
        literal_index_ = 1;
        lexical_ = Lexical::Literal;
        if (literal_index_ == literal_expected_.size()) return complete_literal();
        return true;
    }

    fail(JsonError::InvalidSyntax);
    return false;
}

bool JsonStreamParser::begin_container(Container container) {
    if (!value_expected()) {
        fail(JsonError::InvalidSyntax);
        return false;
    }
    if (depth_ == kMaximumDepth) {
        fail(JsonError::TooDeep);
        return false;
    }
    const auto event_type = container == Container::Object ? JsonEventType::ObjectBegin : JsonEventType::ArrayBegin;
    if (!emit(event_type)) return false;
    mark_value_complete();
    stack_[depth_++] = Frame{
        container,
        container == Container::Object ? Phase::ObjectKeyOrEnd : Phase::ArrayValueOrEnd,
    };
    return true;
}

bool JsonStreamParser::end_container(Container container) {
    if (depth_ == 0 || stack_[depth_ - 1].container != container) {
        fail(JsonError::InvalidSyntax);
        return false;
    }
    const Phase phase = stack_[depth_ - 1].phase;
    const bool valid = container == Container::Object
        ? (phase == Phase::ObjectKeyOrEnd || phase == Phase::ObjectCommaOrEnd)
        : (phase == Phase::ArrayValueOrEnd || phase == Phase::ArrayCommaOrEnd);
    if (!valid) {
        fail(JsonError::InvalidSyntax);
        return false;
    }
    --depth_;
    return emit(container == Container::Object ? JsonEventType::ObjectEnd : JsonEventType::ArrayEnd);
}

bool JsonStreamParser::begin_string() {
    string_is_key_ = depth_ > 0 &&
        (stack_[depth_ - 1].phase == Phase::ObjectKeyOrEnd || stack_[depth_ - 1].phase == Phase::ObjectKey);
    if (!string_is_key_ && !value_expected()) {
        fail(JsonError::InvalidSyntax);
        return false;
    }
    token_.clear();
    token_truncated_ = false;
    pending_high_surrogate_ = 0;
    lexical_ = Lexical::String;
    return true;
}

bool JsonStreamParser::complete_string() {
    if (pending_high_surrogate_ != 0) {
        pending_high_surrogate_ = 0;
        if (!append_codepoint(0xFFFD)) return false;
    }
    lexical_ = Lexical::Normal;
    if (string_is_key_) {
        if (token_truncated_) {
            fail(JsonError::KeyTooLong);
            return false;
        }
        stack_[depth_ - 1].phase = Phase::ObjectColon;
        return emit(JsonEventType::Key, token_.view());
    }
    if (!emit(JsonEventType::String, token_.view(), false, token_truncated_)) return false;
    mark_value_complete();
    return true;
}

bool JsonStreamParser::complete_number() {
    lexical_ = Lexical::Normal;
    if (token_.empty() || token_truncated_ || !valid_number(token_.view())) {
        fail(JsonError::InvalidSyntax);
        return false;
    }
    if (!emit(JsonEventType::Number, token_.view(), false, token_truncated_)) return false;
    mark_value_complete();
    return true;
}

bool JsonStreamParser::complete_literal() {
    lexical_ = Lexical::Normal;
    const std::string_view value = literal_expected_.view();
    const bool result = value == "true";
    const JsonEventType type = value == "null" ? JsonEventType::Null : JsonEventType::Boolean;
    if (!emit(type, value, result)) return false;
    mark_value_complete();
    return true;
}

bool JsonStreamParser::emit(JsonEventType type, std::string_view value, bool boolean, bool truncated) {
    if (!listener_.on_json_event(JsonEvent{type, value, static_cast<std::uint8_t>(depth_), boolean, truncated})) {
        fail(JsonError::ListenerRejected);
        return false;
    }
    return true;
}

bool JsonStreamParser::value_expected() const {
    if (depth_ == 0) return !root_complete_;
    const Phase phase = stack_[depth_ - 1].phase;
    return phase == Phase::ObjectValue || phase == Phase::ArrayValueOrEnd || phase == Phase::ArrayValue;
}

void JsonStreamParser::mark_value_complete() {
    if (depth_ == 0) {
        root_complete_ = true;
        return;
    }
    Frame& parent = stack_[depth_ - 1];
    parent.phase = parent.container == Container::Object ? Phase::ObjectCommaOrEnd : Phase::ArrayCommaOrEnd;
}

bool JsonStreamParser::append_token(char character) {
    if (!token_.append(character)) token_truncated_ = true;
    return true;
}

bool JsonStreamParser::append_codepoint(std::uint32_t codepoint) {
    if (codepoint <= 0x7F) return append_token(static_cast<char>(codepoint));
    if (codepoint <= 0x7FF) {
        return append_token(static_cast<char>(0xC0U | (codepoint >> 6U))) &&
               append_token(static_cast<char>(0x80U | (codepoint & 0x3FU)));
    }
    if (codepoint <= 0xFFFF) {
        return append_token(static_cast<char>(0xE0U | (codepoint >> 12U))) &&
               append_token(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3FU))) &&
               append_token(static_cast<char>(0x80U | (codepoint & 0x3FU)));
    }
    return append_token(static_cast<char>(0xF0U | (codepoint >> 18U))) &&
           append_token(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3FU))) &&
           append_token(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3FU))) &&
           append_token(static_cast<char>(0x80U | (codepoint & 0x3FU)));
}

void JsonStreamParser::fail(JsonError error) {
    if (error_ == JsonError::None) error_ = error;
}

const char* json_error_name(JsonError error) {
    switch (error) {
        case JsonError::None: return "none";
        case JsonError::InvalidSyntax: return "invalid_syntax";
        case JsonError::TooDeep: return "too_deep";
        case JsonError::KeyTooLong: return "key_too_long";
        case JsonError::ListenerRejected: return "listener_rejected";
        case JsonError::Incomplete: return "incomplete";
    }
    return "unknown";
}

}  // namespace hosty
