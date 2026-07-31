#include "hosty/protocol.hpp"

#include <limits>

namespace hosty {
namespace {

bool parse_unsigned(std::string_view value, std::uint32_t& output) {
    if (value.empty()) return false;
    std::uint64_t parsed = 0;
    for (const char character : value) {
        if (character < '0' || character > '9') return false;
        parsed = parsed * 10U + static_cast<unsigned>(character - '0');
        if (parsed > std::numeric_limits<std::uint32_t>::max()) return false;
    }
    output = static_cast<std::uint32_t>(parsed);
    return true;
}

template <std::size_t Capacity>
void copy_display(std::string_view value, FixedString<Capacity>& output) {
    output.assign_truncated(value);
}

bool is_scalar(JsonEventType type) {
    return type == JsonEventType::String || type == JsonEventType::Number ||
           type == JsonEventType::Boolean || type == JsonEventType::Null;
}

}  // namespace

ProtocolParserBase::ProtocolParserBase() : parser_(*this) {}

void ProtocolParserBase::reset_base() {
    parser_.reset();
    protocol_error_ = ProtocolError::None;
    for (auto& key : keys_) key.clear();
}

ProtocolError ProtocolParserBase::finish() {
    if (parser_.finish() != JsonError::None) {
        if (protocol_error_ == ProtocolError::None) protocol_error_ = ProtocolError::Json;
        return protocol_error_;
    }
    if (protocol_error_ == ProtocolError::None && !validate()) {
        if (protocol_error_ == ProtocolError::None) protocol_error_ = ProtocolError::MissingField;
    }
    return protocol_error_;
}

bool ProtocolParserBase::remember_key(const JsonEvent& event) {
    if (event.type != JsonEventType::Key) return true;
    if (event.depth >= keys_.size() || !keys_[event.depth].assign(event.value)) {
        reject(ProtocolError::FieldTooLong);
        return false;
    }
    return true;
}

std::string_view ProtocolParserBase::key_at(std::uint8_t depth) const {
    return depth < keys_.size() ? keys_[depth].view() : std::string_view{};
}

void ProtocolParserBase::reject(ProtocolError error) {
    if (protocol_error_ == ProtocolError::None) protocol_error_ = error;
}

DeviceCodeParser::DeviceCodeParser(DeviceCode& output) : output_(output) { output_ = {}; }

bool DeviceCodeParser::on_json_event(const JsonEvent& event) {
    if (!remember_key(event)) return false;
    if (!is_scalar(event.type) || event.depth != 1) return true;
    const auto key = key_at(event.depth);
    if (event.type == JsonEventType::String) {
        if (key == "deviceCode" && !output_.device_code.assign(event.value)) reject(ProtocolError::FieldTooLong);
        else if (key == "userCode" && !output_.user_code.assign(event.value)) reject(ProtocolError::FieldTooLong);
        else if (key == "verificationUri" && !output_.verification_uri.assign(event.value)) reject(ProtocolError::FieldTooLong);
    } else if (event.type == JsonEventType::Number) {
        std::uint32_t parsed = 0;
        if (!parse_unsigned(event.value, parsed)) reject(ProtocolError::InvalidField);
        else if (key == "intervalSeconds") output_.interval_seconds = parsed;
        else if (key == "expiresInSeconds") output_.expires_in_seconds = parsed;
    }
    return protocol_error_ == ProtocolError::None;
}

bool DeviceCodeParser::validate() {
    return !output_.device_code.empty() && !output_.user_code.empty() && output_.expires_in_seconds > 0;
}

DeviceTokenParser::DeviceTokenParser(DeviceTokenResult& output) : output_(output) { output_ = {}; }

bool DeviceTokenParser::on_json_event(const JsonEvent& event) {
    if (!remember_key(event)) return false;
    if (!is_scalar(event.type) || event.depth != 1) return true;
    const auto key = key_at(event.depth);
    if (key == "status" && event.type == JsonEventType::String) {
        saw_status_ = true;
        if (event.value == "pending") output_.status = DeviceTokenStatus::Pending;
        else if (event.value == "approved") output_.status = DeviceTokenStatus::Approved;
        else if (event.value == "denied") output_.status = DeviceTokenStatus::Denied;
        else if (event.value == "expired") output_.status = DeviceTokenStatus::Expired;
        else output_.status = DeviceTokenStatus::Unknown;
    } else if (key == "token" && event.type == JsonEventType::String) {
        if (!output_.token.assign(event.value)) reject(ProtocolError::FieldTooLong);
    }
    return protocol_error_ == ProtocolError::None;
}

bool DeviceTokenParser::validate() {
    return saw_status_ && (output_.status != DeviceTokenStatus::Approved || !output_.token.empty());
}

SessionParser::SessionParser(SessionInfo& output) : output_(output) { output_ = {}; }

bool SessionParser::on_json_event(const JsonEvent& event) {
    if (!remember_key(event)) return false;
    if (event.type == JsonEventType::ObjectBegin && event.depth == 1 && key_at(1) == "user") {
        user_depth_ = 1;
        return true;
    }
    if (event.type == JsonEventType::ObjectEnd && event.depth == user_depth_) {
        user_depth_ = -1;
        return true;
    }
    if (!is_scalar(event.type)) return true;

    const auto key = key_at(event.depth);
    if (event.depth == 1) {
        if (key == "authenticated" && event.type == JsonEventType::Boolean) {
            output_.authenticated = event.boolean;
            saw_authenticated_ = true;
        } else if (key == "kind" && event.type == JsonEventType::String) {
            copy_display(event.value, output_.credential_kind);
        }
    } else if (user_depth_ >= 0 && event.depth == user_depth_ + 1 && event.type == JsonEventType::String) {
        if (key == "id" && !output_.user_id.assign(event.value)) reject(ProtocolError::FieldTooLong);
        else if (key == "displayName") copy_display(event.value, output_.display_name);
        else if (key == "role") {
            copy_display(event.value, output_.role);
            output_.administrator = event.value == "host.admin";
        }
    }
    return protocol_error_ == ProtocolError::None;
}

bool SessionParser::validate() {
    return saw_authenticated_ && (!output_.authenticated || !output_.role.empty());
}

CoreStatusParser::CoreStatusParser(CoreSnapshot& output) : output_(output) {
    output_.version.clear();
    output_.server_time.clear();
}

bool CoreStatusParser::on_json_event(const JsonEvent& event) {
    if (!remember_key(event)) return false;
    if (!is_scalar(event.type) || event.depth != 1 || event.type != JsonEventType::String) return true;
    const auto key = key_at(1);
    if (key == "version" && !output_.version.assign(event.value)) reject(ProtocolError::FieldTooLong);
    else if (key == "serverTime") copy_display(event.value, output_.server_time);
    else if (key == "status") running_ = event.value == "running";
    return protocol_error_ == ProtocolError::None;
}

bool CoreStatusParser::validate() {
    return running_ && !output_.version.empty();
}

CoreUpdateStatusParser::CoreUpdateStatusParser(CoreSnapshot& output) : output_(output) {
    output_.core_update = {};
}

bool CoreUpdateStatusParser::on_json_event(const JsonEvent& event) {
    if (!remember_key(event)) return false;
    if (!is_scalar(event.type) || event.depth != 1) return true;
    const auto key = key_at(1);
    if (key == "updateAvailable" && event.type == JsonEventType::Boolean) {
        output_.core_update.available = event.boolean;
        output_.core_update.known = true;
        saw_available_ = true;
    } else if (key == "checkedAt" && event.type == JsonEventType::String) {
        copy_display(event.value, output_.core_update.checked_at);
    } else if (key == "error" && event.type == JsonEventType::String) {
        copy_display(event.value, output_.core_update.error);
    }
    return protocol_error_ == ProtocolError::None;
}

bool CoreUpdateStatusParser::validate() { return saw_available_; }

AppsResponseParser::AppsResponseParser(CoreSnapshot& output) : output_(output) {
    output_.apps.clear();
    output_.update_check = {};
}

bool AppsResponseParser::on_json_event(const JsonEvent& event) {
    if (!remember_key(event)) return false;

    if (event.type == JsonEventType::ArrayBegin && event.depth == 1 && key_at(1) == "apps") {
        apps_array_depth_ = 1;
        saw_apps_ = true;
        return true;
    }
    if (event.type == JsonEventType::ArrayEnd && event.depth == apps_array_depth_) {
        apps_array_depth_ = -1;
        return true;
    }
    if (event.type == JsonEventType::ObjectBegin && apps_array_depth_ >= 0 &&
        event.depth == apps_array_depth_ + 1) {
        if (app_object_depth_ >= 0) {
            reject(ProtocolError::InvalidField);
            return false;
        }
        current_app_ = {};
        app_object_depth_ = event.depth;
        return true;
    }
    if (event.type == JsonEventType::ObjectEnd && event.depth == app_object_depth_) {
        if (current_app_.id.empty()) {
            reject(ProtocolError::MissingField);
            return false;
        }
        if (current_app_.display_name.empty()) current_app_.display_name.assign_truncated(current_app_.id.view());
        if (!output_.apps.push_back(current_app_)) {
            reject(ProtocolError::TooManyItems);
            return false;
        }
        app_object_depth_ = -1;
        capabilities_depth_ = -1;
        app_update_depth_ = -1;
        return true;
    }

    if (app_object_depth_ >= 0 && event.type == JsonEventType::ArrayBegin &&
        event.depth == app_object_depth_ + 1 && key_at(event.depth) == "capabilities") {
        capabilities_depth_ = event.depth;
        return true;
    }
    if (event.type == JsonEventType::ArrayEnd && event.depth == capabilities_depth_) {
        capabilities_depth_ = -1;
        return true;
    }
    if (app_object_depth_ >= 0 && event.type == JsonEventType::ObjectBegin &&
        event.depth == app_object_depth_ + 1 && key_at(event.depth) == "updateCheck") {
        current_app_.update.checked = true;
        app_update_depth_ = event.depth;
        return true;
    }
    if (event.type == JsonEventType::ObjectEnd && event.depth == app_update_depth_) {
        app_update_depth_ = -1;
        return true;
    }

    if (event.type == JsonEventType::ObjectBegin && event.depth == 1 && key_at(1) == "updateCheck") {
        output_.update_check.known = true;
        fleet_update_depth_ = 1;
        return true;
    }
    if (event.type == JsonEventType::ObjectEnd && event.depth == fleet_update_depth_) {
        fleet_update_depth_ = -1;
        return true;
    }

    if (event.type == JsonEventType::String && capabilities_depth_ >= 0 &&
        event.depth == capabilities_depth_ + 1) {
        if (event.value == "logs") current_app_.logs_available = true;
        return true;
    }
    if (!is_scalar(event.type)) return true;

    if (app_update_depth_ >= 0 && event.depth == app_update_depth_ + 1) apply_app_update_scalar(event);
    else if (app_object_depth_ >= 0 && event.depth == app_object_depth_ + 1) apply_app_scalar(event);
    else if (fleet_update_depth_ >= 0 && event.depth == fleet_update_depth_ + 1) {
        const auto key = key_at(event.depth);
        if (key == "running" && event.type == JsonEventType::Boolean) output_.update_check.running = event.boolean;
        else if (key == "lastCompletedAt" && event.type == JsonEventType::String) {
            copy_display(event.value, output_.update_check.last_completed_at);
        }
    }
    return protocol_error_ == ProtocolError::None;
}

void AppsResponseParser::apply_app_scalar(const JsonEvent& event) {
    const auto key = key_at(event.depth);
    if (event.type == JsonEventType::String) {
        if (key == "id" && !current_app_.id.assign(event.value)) reject(ProtocolError::FieldTooLong);
        else if (key == "displayName") copy_display(event.value, current_app_.display_name);
        else if (key == "version") copy_display(event.value, current_app_.version);
        else if (key == "runtimeState") current_app_.runtime_state = parse_runtime_state(event.value);
        else if (key == "operationStatus") current_app_.operation_state = parse_operation_state(event.value);
        else if (key == "lastError") copy_display(event.value, current_app_.last_error);
    } else if (event.type == JsonEventType::Boolean) {
        if (key == "system") current_app_.system = event.boolean;
        else if (key == "autostart") current_app_.autostart = event.boolean;
        else if (key == "live") current_app_.live = event.boolean;
    }
}

void AppsResponseParser::apply_app_update_scalar(const JsonEvent& event) {
    const auto key = key_at(event.depth);
    if (event.type == JsonEventType::Boolean) {
        if (key == "updateAvailable") current_app_.update.available = event.boolean;
        else if (key == "requiresReview") current_app_.update.requires_review = event.boolean;
    } else if (event.type == JsonEventType::String) {
        if (key == "planDigest" && !current_app_.update.plan_digest.assign(event.value)) reject(ProtocolError::FieldTooLong);
        else if (key == "error") {
            current_app_.update.has_error = true;
            copy_display(event.value, current_app_.update.error);
        }
    }
}

bool AppsResponseParser::validate() {
    return saw_apps_ && app_object_depth_ < 0;
}

NotificationsParser::NotificationsParser(NotificationSnapshot& output) : output_(output) { output_ = {}; }

bool NotificationsParser::on_json_event(const JsonEvent& event) {
    if (!remember_key(event)) return false;
    if (event.type == JsonEventType::ArrayBegin && event.depth == 1 && key_at(1) == "notifications") {
        notifications_depth_ = 1;
        saw_notifications_ = true;
        return true;
    }
    if (event.type == JsonEventType::ArrayEnd && event.depth == notifications_depth_) {
        notifications_depth_ = -1;
        return true;
    }
    if (event.type == JsonEventType::ObjectBegin && notifications_depth_ >= 0 &&
        event.depth == notifications_depth_ + 1) {
        current_ = {};
        notification_depth_ = event.depth;
        return true;
    }
    if (event.type == JsonEventType::ObjectEnd && event.depth == notification_depth_) {
        if (current_.id.empty() || current_.title.empty()) {
            reject(ProtocolError::MissingField);
            return false;
        }
        if (!output_.items.push_back(current_)) {
            reject(ProtocolError::TooManyItems);
            return false;
        }
        notification_depth_ = -1;
        source_depth_ = -1;
        return true;
    }
    if (event.type == JsonEventType::ObjectBegin && notification_depth_ >= 0 &&
        event.depth == notification_depth_ + 1 && key_at(event.depth) == "source") {
        source_depth_ = event.depth;
        return true;
    }
    if (event.type == JsonEventType::ObjectEnd && event.depth == source_depth_) {
        source_depth_ = -1;
        return true;
    }
    if (!is_scalar(event.type)) return true;

    const auto key = key_at(event.depth);
    if (event.depth == 1) {
        if (key == "unreadCount" && event.type == JsonEventType::Number) {
            if (!parse_unsigned(event.value, output_.unread_count)) reject(ProtocolError::InvalidField);
        } else if (key == "updatedAt" && event.type == JsonEventType::String) {
            copy_display(event.value, output_.updated_at);
        }
    } else if (source_depth_ >= 0 && event.depth == source_depth_ + 1 && key == "appId" &&
               event.type == JsonEventType::String) {
        copy_display(event.value, current_.app_id);
    } else if (notification_depth_ >= 0 && event.depth == notification_depth_ + 1) {
        if (event.type == JsonEventType::String) {
            if (key == "id" && !current_.id.assign(event.value)) reject(ProtocolError::FieldTooLong);
            else if (key == "title") copy_display(event.value, current_.title);
            else if (key == "body") copy_display(event.value, current_.body);
            else if (key == "createdAt") copy_display(event.value, current_.created_at);
            else if (key == "level") current_.level = parse_notification_level(event.value);
        } else if (key == "read" && event.type == JsonEventType::Boolean) current_.read = event.boolean;
    }
    return protocol_error_ == ProtocolError::None;
}

bool NotificationsParser::validate() {
    return saw_notifications_ && notification_depth_ < 0;
}

LogTailParser::LogTailParser(LogTail& output) : output_(output) { output_ = {}; }

bool LogTailParser::on_json_event(const JsonEvent& event) {
    if (!remember_key(event)) return false;
    if (event.depth != 1 || event.type != JsonEventType::String) return true;
    const auto key = key_at(1);
    if (key == "appId" && !output_.app_id.assign(event.value)) reject(ProtocolError::FieldTooLong);
    else if (key == "text") output_.text.assign_truncated(event.value);
    return protocol_error_ == ProtocolError::None;
}

bool LogTailParser::validate() { return !output_.app_id.empty(); }

const char* protocol_error_name(ProtocolError error) {
    switch (error) {
        case ProtocolError::None: return "none";
        case ProtocolError::Json: return "json";
        case ProtocolError::MissingField: return "missing_field";
        case ProtocolError::InvalidField: return "invalid_field";
        case ProtocolError::FieldTooLong: return "field_too_long";
        case ProtocolError::TooManyItems: return "too_many_items";
    }
    return "unknown";
}

}  // namespace hosty
