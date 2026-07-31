#pragma once

#include "hosty/bounded.hpp"
#include "hosty/model.hpp"
#include "hosty/protocol.hpp"
#include "hosty/sse.hpp"

#include <esp_err.h>
#include <esp_http_client.h>

#include <cstdint>
#include <string_view>

struct HttpResult {
    esp_err_t transport_error = ESP_OK;
    int status_code = 0;
    hosty::ProtocolError protocol_error = hosty::ProtocolError::None;

    [[nodiscard]] bool ok() const {
        return transport_error == ESP_OK && status_code >= 200 && status_code < 300 &&
               protocol_error == hosty::ProtocolError::None;
    }
    [[nodiscard]] bool unauthorized() const { return status_code == 401 || status_code == 403; }
};

class EventStreamObserver : public hosty::SseListener {
public:
    virtual void on_stream_connected() = 0;
    virtual void on_stream_closed(const HttpResult& result) = 0;
};

class HostyClient {
public:
    bool configure(std::string_view origin, std::string_view access_token);
    void set_access_token(std::string_view access_token);

    HttpResult request_device_code(std::string_view label, hosty::DeviceCode& output) const;
    HttpResult poll_device_token(std::string_view device_code, hosty::DeviceTokenResult& output) const;
    HttpResult read_session(hosty::SessionInfo& output) const;
    HttpResult read_core_status(hosty::CoreSnapshot& output) const;
    HttpResult read_core_update_status(hosty::CoreSnapshot& output) const;
    HttpResult read_apps(hosty::CoreSnapshot& output) const;
    HttpResult read_notifications(hosty::NotificationSnapshot& output) const;
    HttpResult read_log_tail(std::string_view app_id, hosty::LogTail& output) const;

    HttpResult app_lifecycle(std::string_view app_id, std::string_view action) const;
    HttpResult set_autostart(std::string_view app_id, bool enabled) const;
    HttpResult start_update_check() const;
    HttpResult apply_routine_update(std::string_view app_id, std::string_view plan_digest) const;
    HttpResult restart_core() const;
    HttpResult update_core() const;
    HttpResult logout() const;

    HttpResult stream_events(EventStreamObserver& observer) const;

private:
    struct ResponseContext {
        hosty::ProtocolParserBase* parser = nullptr;
        bool parser_failed = false;
    };

    static esp_err_t http_event(esp_http_client_event_t* event);
    HttpResult request(esp_http_client_method_t method, std::string_view path, std::string_view body,
                       bool authenticated, hosty::ProtocolParserBase* parser) const;
    bool make_url(std::string_view path, hosty::FixedString<320>& output) const;
    bool make_app_path(std::string_view app_id, std::string_view suffix, hosty::FixedString<256>& output) const;
    static bool append_json_string(std::string_view value, hosty::FixedString<256>& output);
    void apply_common_headers(esp_http_client_handle_t client, bool authenticated,
                              std::string_view accept = "application/json") const;

    hosty::FixedString<192> origin_;
    hosty::FixedString<96> access_token_;
    bool secure_ = false;
};
