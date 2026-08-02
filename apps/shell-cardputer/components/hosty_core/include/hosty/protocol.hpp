#pragma once

#include "hosty/json_stream.hpp"
#include "hosty/model.hpp"

#include <array>
#include <cstdint>
#include <string_view>

namespace hosty {

enum class ProtocolError : std::uint8_t {
    None,
    Json,
    MissingField,
    InvalidField,
    FieldTooLong,
    TooManyItems,
};

class ProtocolParserBase : public JsonListener {
public:
    JsonError feed(std::string_view bytes) { return parser_.feed(bytes); }
    ProtocolError finish();
    [[nodiscard]] ProtocolError protocol_error() const { return protocol_error_; }
    [[nodiscard]] JsonError json_error() const { return parser_.error(); }

protected:
    ProtocolParserBase();
    void reset_base();
    bool remember_key(const JsonEvent& event);
    [[nodiscard]] std::string_view key_at(std::uint8_t depth) const;
    void reject(ProtocolError error);
    virtual bool validate() = 0;

private:
    JsonStreamParser parser_;
    std::array<FixedString<64>, JsonStreamParser::kMaximumDepth + 1> keys_{};

protected:
    ProtocolError protocol_error_ = ProtocolError::None;
};

class DeviceCodeParser final : public ProtocolParserBase {
public:
    explicit DeviceCodeParser(DeviceCode& output);
    bool on_json_event(const JsonEvent& event) override;

private:
    bool validate() override;
    DeviceCode& output_;
};

class DeviceTokenParser final : public ProtocolParserBase {
public:
    explicit DeviceTokenParser(DeviceTokenResult& output);
    bool on_json_event(const JsonEvent& event) override;

private:
    bool validate() override;
    DeviceTokenResult& output_;
    bool saw_status_ = false;
};

class SessionParser final : public ProtocolParserBase {
public:
    explicit SessionParser(SessionInfo& output);
    bool on_json_event(const JsonEvent& event) override;

private:
    bool validate() override;
    SessionInfo& output_;
    int user_depth_ = -1;
    bool saw_authenticated_ = false;
};

class CoreStatusParser final : public ProtocolParserBase {
public:
    explicit CoreStatusParser(CoreSnapshot& output);
    bool on_json_event(const JsonEvent& event) override;

private:
    bool validate() override;
    CoreSnapshot& output_;
    bool running_ = false;
};

class CoreUpdateStatusParser final : public ProtocolParserBase {
public:
    explicit CoreUpdateStatusParser(CoreSnapshot& output);
    bool on_json_event(const JsonEvent& event) override;

private:
    bool validate() override;
    CoreSnapshot& output_;
    bool saw_available_ = false;
};

class AppsResponseParser final : public ProtocolParserBase {
public:
    explicit AppsResponseParser(CoreSnapshot& output);
    bool on_json_event(const JsonEvent& event) override;

private:
    bool validate() override;
    void apply_app_scalar(const JsonEvent& event);
    void apply_app_update_scalar(const JsonEvent& event);

    CoreSnapshot& output_;
    AppSummary current_app_;
    int apps_array_depth_ = -1;
    int app_object_depth_ = -1;
    int app_update_depth_ = -1;
    int fleet_update_depth_ = -1;
    bool saw_apps_ = false;
};

class NotificationsParser final : public ProtocolParserBase {
public:
    explicit NotificationsParser(NotificationSnapshot& output);
    bool on_json_event(const JsonEvent& event) override;

private:
    bool validate() override;
    NotificationSnapshot& output_;
    Notification current_;
    int notifications_depth_ = -1;
    int notification_depth_ = -1;
    int source_depth_ = -1;
    bool saw_notifications_ = false;
};

[[nodiscard]] const char* protocol_error_name(ProtocolError error);

}  // namespace hosty
