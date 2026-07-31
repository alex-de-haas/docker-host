#pragma once

#include "hosty/bounded.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace hosty {

enum class JsonEventType : std::uint8_t {
    ObjectBegin,
    ObjectEnd,
    ArrayBegin,
    ArrayEnd,
    Key,
    String,
    Number,
    Boolean,
    Null,
};

struct JsonEvent {
    JsonEventType type;
    std::string_view value;
    std::uint8_t depth;
    bool boolean = false;
    bool truncated = false;
};

class JsonListener {
public:
    virtual ~JsonListener() = default;
    virtual bool on_json_event(const JsonEvent& event) = 0;
};

enum class JsonError : std::uint8_t {
    None,
    InvalidSyntax,
    TooDeep,
    KeyTooLong,
    ListenerRejected,
    Incomplete,
};

class JsonStreamParser {
public:
    static constexpr std::size_t kMaximumDepth = 16;
    static constexpr std::size_t kMaximumTokenBytes = 2048;

    explicit JsonStreamParser(JsonListener& listener);

    JsonError feed(std::string_view bytes);
    JsonError finish();
    void reset();

    [[nodiscard]] JsonError error() const { return error_; }

private:
    enum class Container : std::uint8_t { Object, Array };
    enum class Phase : std::uint8_t {
        ObjectKeyOrEnd,
        ObjectKey,
        ObjectColon,
        ObjectValue,
        ObjectCommaOrEnd,
        ArrayValueOrEnd,
        ArrayValue,
        ArrayCommaOrEnd,
    };
    enum class Lexical : std::uint8_t { Normal, String, Escape, Unicode, Number, Literal };

    struct Frame {
        Container container;
        Phase phase;
    };

    bool process(char character, bool& consume);
    bool process_normal(char character, bool& consume);
    bool begin_container(Container container);
    bool end_container(Container container);
    bool begin_string();
    bool complete_string();
    bool complete_number();
    bool complete_literal();
    bool emit(JsonEventType type, std::string_view value = {}, bool boolean = false, bool truncated = false);
    bool value_expected() const;
    void mark_value_complete();
    bool append_token(char character);
    bool append_codepoint(std::uint32_t codepoint);
    void fail(JsonError error);

    JsonListener& listener_;
    std::array<Frame, kMaximumDepth> stack_{};
    std::size_t depth_ = 0;
    bool root_complete_ = false;
    Lexical lexical_ = Lexical::Normal;
    FixedString<kMaximumTokenBytes> token_;
    bool token_truncated_ = false;
    bool string_is_key_ = false;
    FixedString<5> literal_expected_;
    std::size_t literal_index_ = 0;
    std::uint32_t unicode_value_ = 0;
    std::uint8_t unicode_digits_ = 0;
    std::uint16_t pending_high_surrogate_ = 0;
    JsonError error_ = JsonError::None;
};

[[nodiscard]] const char* json_error_name(JsonError error);

}  // namespace hosty
