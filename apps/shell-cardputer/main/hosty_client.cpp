#include "hosty_client.hpp"

#include <esp_crt_bundle.h>
#include <esp_log.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <esp_random.h>
#include <freertos/task.h>
#include <cstdio>

#include <cerrno>
#include <cstdint>

namespace {

constexpr const char* kTag = "hosty_http";
constexpr int kLifecycleRequestTimeoutMs = 120'000;

bool unreserved(char character) {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') || character == '-' || character == '.' ||
           character == '_' || character == '~';
}

char hex_digit(unsigned value) { return static_cast<char>(value < 10 ? '0' + value : 'A' + value - 10); }

}  // namespace

bool HostyClient::configure(std::string_view origin, std::string_view access_token) {
    release();
    if (!origin_.assign(origin) || !access_token_.assign(access_token)) return false;
    secure_ = origin.starts_with("https://");
    if (request_lock_ == nullptr) {
        request_lock_ = xSemaphoreCreateMutex();
        if (request_lock_ == nullptr) return false;
    }
    return true;
}

void HostyClient::set_access_token(std::string_view access_token) {
    release();
    if (request_lock_ != nullptr) xSemaphoreTake(request_lock_, portMAX_DELAY);
    if (!access_token_.assign(access_token)) access_token_.clear();
    if (request_lock_ != nullptr) xSemaphoreGive(request_lock_);
}

HttpResult HostyClient::request_device_code(std::string_view label, hosty::DeviceCode& output) const {
    hosty::FixedString<256> body;
    if (!body.append("{\"label\":" ) || !append_json_string(label, body) || !body.append('}')) {
        return {ESP_ERR_INVALID_SIZE, 0, hosty::ProtocolError::FieldTooLong};
    }
    hosty::DeviceCodeParser parser(output);
    return request(HTTP_METHOD_POST, "/api/auth/device/code", body.view(), false, &parser);
}

HttpResult HostyClient::poll_device_token(std::string_view device_code, hosty::DeviceTokenResult& output) const {
    hosty::FixedString<256> body;
    if (!body.append("{\"deviceCode\":" ) || !append_json_string(device_code, body) || !body.append('}')) {
        return {ESP_ERR_INVALID_SIZE, 0, hosty::ProtocolError::FieldTooLong};
    }
    hosty::DeviceTokenParser parser(output);
    return request(HTTP_METHOD_POST, "/api/auth/device/token", body.view(), false, &parser);
}

HttpResult HostyClient::read_session(hosty::SessionInfo& output) const {
    hosty::SessionParser parser(output);
    return request(HTTP_METHOD_GET, "/api/auth/session", {}, true, &parser);
}

HttpResult HostyClient::read_core_status(hosty::CoreSnapshot& output) const {
    hosty::CoreStatusParser parser(output);
    return request(HTTP_METHOD_GET, "/api/core/status", {}, true, &parser);
}

HttpResult HostyClient::read_core_update_status(hosty::CoreSnapshot& output) const {
    hosty::CoreUpdateStatusParser parser(output);
    return request(HTTP_METHOD_GET, "/api/core/update-status", {}, true, &parser);
}

HttpResult HostyClient::read_apps(hosty::CoreSnapshot& output) const {
    hosty::AppsResponseParser parser(output);
    return request(HTTP_METHOD_GET, "/api/apps", {}, true, &parser);
}

HttpResult HostyClient::read_notifications(hosty::NotificationSnapshot& output) const {
    hosty::NotificationsParser parser(output);
    return request(HTTP_METHOD_GET, "/api/notifications?limit=16&offset=0", {}, true, &parser);
}

HttpResult HostyClient::app_lifecycle(std::string_view app_id, std::string_view action) const {
    if (action != "start" && action != "stop" && action != "restart") return {ESP_ERR_INVALID_ARG};
    hosty::FixedString<256> path;
    hosty::FixedString<24> suffix;
    static_cast<void>(suffix.append('/'));
    static_cast<void>(suffix.append(action));
    if (!make_app_path(app_id, suffix.view(), path)) return {ESP_ERR_INVALID_SIZE};
    return request(HTTP_METHOD_POST, path.view(), "{}", true, nullptr, kLifecycleRequestTimeoutMs);
}

HttpResult HostyClient::set_autostart(std::string_view app_id, bool enabled) const {
    hosty::FixedString<256> path;
    if (!make_app_path(app_id, "/autostart", path)) return {ESP_ERR_INVALID_SIZE};
    return request(HTTP_METHOD_POST, path.view(), enabled ? "{\"autostart\":true}" : "{\"autostart\":false}", true, nullptr);
}

HttpResult HostyClient::start_update_check() const {
    return request(HTTP_METHOD_POST, "/api/apps/update-check", "{}", true, nullptr);
}

HttpResult HostyClient::apply_routine_update(std::string_view app_id, std::string_view plan_digest) const {
    hosty::FixedString<256> path;
    hosty::FixedString<256> body;
    if (!make_app_path(app_id, "/update", path) || !body.append("{\"planDigest\":" ) ||
        !append_json_string(plan_digest, body) || !body.append('}')) {
        return {ESP_ERR_INVALID_SIZE};
    }
    return request(HTTP_METHOD_POST, path.view(), body.view(), true, nullptr);
}

HttpResult HostyClient::restart_core() const {
    hosty::CoreRestartState state;
    if (pending_restart_id_.empty()) {
        hosty::CoreRestartParser development(state, true);
        const HttpResult read = request(HTTP_METHOD_GET, "/api/core/development", {}, true, &development);
        if (!read.ok()) return read;
        char id[33];
        std::snprintf(id, sizeof(id), "%08lx%08lx%08lx%08lx",
                      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
                      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
        hosty::FixedString<256> body;
        if (!body.append("{\"requestId\":") || !append_json_string(id, body) ||
            !body.append(",\"instance\":") || !append_json_string(state.instance.view(), body) ||
            !body.append(",\"sourceRevision\":") || !append_json_string(state.source_revision.view(), body) ||
            !body.append('}')) return {ESP_ERR_INVALID_SIZE};
        pending_restart_id_.assign_truncated(id);
        ESP_LOGI(kTag, "Core restart request=%s", pending_restart_id_.c_str());
        hosty::CoreRestartParser receipt(state, false);
        const HttpResult accepted = request(HTTP_METHOD_POST, "/api/core/restart", body.view(), true, &receipt);
        if (accepted.status_code >= 400 && accepted.transport_error == ESP_OK) {
            pending_restart_id_.clear();
            return accepted;
        }
        // A dropped POST response is uncertain: recover by ID, never issue another restart.
    }
    hosty::FixedString<96> path{"/api/core/operations/"};
    static_cast<void>(path.append(pending_restart_id_.view()));
    const auto deadline = esp_timer_get_time() + 120LL * 1'000'000;
    while (esp_timer_get_time() < deadline) {
        vTaskDelay(pdMS_TO_TICKS(2'000));
        hosty::CoreRestartParser operation(state, false);
        const HttpResult result = request(HTTP_METHOD_GET, path.view(), {}, true, &operation, 5'000);
        if (result.unauthorized()) return result;
        if (!result.ok()) continue;
        if (state.status == "completed" || state.status == "failed") {
            pending_restart_id_.clear();
            return state.status == "completed" ? result : HttpResult{ESP_FAIL, result.status_code};
        }
    }
    // Retain the ID for another explicit status-recovery attempt during this session.
    return {ESP_ERR_TIMEOUT};
}

HttpResult HostyClient::update_core() const {
    return request(HTTP_METHOD_POST, "/api/core/update", "{}", true, nullptr);
}

HttpResult HostyClient::logout() const {
    return request(HTTP_METHOD_POST, "/api/auth/logout", "{}", true, nullptr);
}

HttpResult HostyClient::mark_notifications_read() const {
    // A null id list means "all of them", the same request the Shell notification bell sends for its
    // mark-all-read button. This console shows the newest alert rather than a selectable list, so
    // per-notification acknowledgement would have nothing to select.
    return request(HTTP_METHOD_POST, "/api/notifications/read", "{\"ids\":null}", true, nullptr);
}

esp_err_t HostyClient::http_event(esp_http_client_event_t* event) {
    auto* context = static_cast<ResponseContext*>(event->user_data);
    if (event->event_id == HTTP_EVENT_ON_DATA && context != nullptr && context->parser != nullptr && event->data_len > 0) {
        const auto error = context->parser->feed(std::string_view(static_cast<const char*>(event->data),
                                                                  static_cast<std::size_t>(event->data_len)));
        if (error != hosty::JsonError::None) {
            context->parser_failed = true;
            return ESP_FAIL;
        }
    }
    return ESP_OK;
}

void HostyClient::release() const {
    if (request_lock_ == nullptr) return;
    xSemaphoreTake(request_lock_, portMAX_DELAY);
    if (client_ != nullptr) esp_http_client_cleanup(client_);
    client_ = nullptr;
    response_ = {};
    xSemaphoreGive(request_lock_);
}

void HostyClient::release_if_idle(std::uint64_t now_ms) const {
    if (request_lock_ == nullptr || xSemaphoreTake(request_lock_, 0) != pdTRUE) return;
    if (client_ != nullptr && now_ms >= last_request_ms_ && now_ms - last_request_ms_ >= 5'000) {
        esp_http_client_cleanup(client_);
        client_ = nullptr;
        response_ = {};
    }
    xSemaphoreGive(request_lock_);
}

HttpResult HostyClient::request(esp_http_client_method_t method, std::string_view path, std::string_view body,
                                bool authenticated, hosty::ProtocolParserBase* parser, int timeout_ms) const {
    hosty::FixedString<320> url;
    if (!make_url(path, url)) return {ESP_ERR_INVALID_SIZE};
    if (request_lock_ == nullptr) return {ESP_ERR_INVALID_STATE};
    xSemaphoreTake(request_lock_, portMAX_DELAY);
    response_ = {parser, false};
    const std::int64_t started = esp_timer_get_time();
    if (client_ == nullptr) {
        esp_http_client_config_t config{};
        config.url = url.c_str();
        config.buffer_size = 1024;
        config.buffer_size_tx = 512;
        config.keep_alive_enable = true;
        config.disable_auto_redirect = true;
        config.event_handler = &HostyClient::http_event;
        config.user_data = &response_;
        if (secure_) config.crt_bundle_attach = esp_crt_bundle_attach;
        client_ = esp_http_client_init(&config);
    }
    if (client_ == nullptr) {
        response_ = {};
        xSemaphoreGive(request_lock_);
        return {ESP_ERR_NO_MEM};
    }
    HttpResult result;
    result.transport_error = esp_http_client_set_url(client_, url.c_str());
    if (result.transport_error == ESP_OK) result.transport_error = esp_http_client_set_method(client_, method);
    if (result.transport_error == ESP_OK) result.transport_error = esp_http_client_set_timeout_ms(client_, timeout_ms);
    apply_common_headers(client_, authenticated);
    // Clear per-request state as well as setting it: a GET following a POST must not
    // retain the old body, and an anonymous request must not inherit a bearer token.
    if (body.empty()) esp_http_client_delete_header(client_, "Content-Type");
    else esp_http_client_set_header(client_, "Content-Type", "application/json");
    if (result.transport_error == ESP_OK) {
        result.transport_error = esp_http_client_set_post_field(client_, body.empty() ? nullptr : body.data(),
                                                                static_cast<int>(body.size()));
        // Clearing the body deletes Content-Type in ESP-IDF. A new GET has no such
        // header, so ESP_ERR_NOT_FOUND is successful clearing, not a transport error.
        if (body.empty() && result.transport_error == ESP_ERR_NOT_FOUND) result.transport_error = ESP_OK;
    }
    if (result.transport_error == ESP_OK) result.transport_error = esp_http_client_perform(client_);
    result.status_code = esp_http_client_get_status_code(client_);
    if (result.transport_error == ESP_OK && result.status_code >= 200 && result.status_code < 300 && parser != nullptr) {
        result.protocol_error = parser->finish();
    } else if (response_.parser_failed) result.protocol_error = hosty::ProtocolError::Json;
    ESP_LOGI(kTag, "%s %.*s: %lld ms HTTP=%d transport=%s protocol=%s heap=%u largest=%u",
             method == HTTP_METHOD_GET ? "GET" : "POST", static_cast<int>(path.size()), path.data(),
             static_cast<long long>((esp_timer_get_time() - started) / 1000), result.status_code,
             esp_err_to_name(result.transport_error), hosty::protocol_error_name(result.protocol_error),
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
             static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
    // Never replay a mutation after an ambiguous transport failure. The next explicit
    // request gets a clean client; parser output from a failed read is not installed.
    if (!result.ok()) {
        esp_http_client_cleanup(client_);
        client_ = nullptr;
    } else {
        esp_http_client_set_post_field(client_, nullptr, 0);
    }
    response_ = {};
    last_request_ms_ = static_cast<std::uint64_t>(esp_timer_get_time() / 1000);
    xSemaphoreGive(request_lock_);
    return result;
}

bool HostyClient::make_url(std::string_view path, hosty::FixedString<320>& output) const {
    output.clear();
    return output.append(origin_.view()) && output.append(path);
}

bool HostyClient::make_app_path(std::string_view app_id, std::string_view suffix, hosty::FixedString<256>& output) const {
    output.clear();
    if (!output.append("/api/apps/")) return false;
    for (const unsigned char character : app_id) {
        if (unreserved(static_cast<char>(character))) {
            if (!output.append(static_cast<char>(character))) return false;
        } else if (!output.append('%') || !output.append(hex_digit(character >> 4U)) ||
                   !output.append(hex_digit(character & 0x0FU))) {
            return false;
        }
    }
    return output.append(suffix);
}

bool HostyClient::append_json_string(std::string_view value, hosty::FixedString<256>& output) {
    if (!output.append('"')) return false;
    for (const unsigned char character : value) {
        if (character == '"' || character == '\\') {
            if (!output.append('\\') || !output.append(static_cast<char>(character))) return false;
        } else if (character < 0x20) {
            if (!output.append("\\u00") || !output.append(hex_digit(character >> 4U)) ||
                !output.append(hex_digit(character & 0x0FU))) return false;
        } else if (!output.append(static_cast<char>(character))) return false;
    }
    return output.append('"');
}

void HostyClient::apply_common_headers(esp_http_client_handle_t client, bool authenticated,
                                       std::string_view accept) const {
    esp_http_client_set_header(client, "Accept", accept.data());
    esp_http_client_set_header(client, "User-Agent", "Hosty-Cardputer");
    if (authenticated && !access_token_.empty()) {
        hosty::FixedString<112> authorization;
        static_cast<void>(authorization.append("Bearer "));
        static_cast<void>(authorization.append(access_token_.view()));
        esp_http_client_set_header(client, "Authorization", authorization.c_str());
    } else {
        esp_http_client_delete_header(client, "Authorization");
    }
}
