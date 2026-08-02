#include "hosty_client.hpp"

#include <esp_crt_bundle.h>
#include <esp_log.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>

#include <cerrno>
#include <cstdint>

namespace {

constexpr const char* kTag = "hosty_http";
constexpr int kLifecycleRequestTimeoutMs = 120'000;

// Two missed keep-alive comments. Core sends one every 20 seconds, so this tolerates a single late
// heartbeat and still notices a dead connection long before TCP keepalive would.
constexpr std::int64_t kStreamSilenceLimitUs = 50LL * 1'000'000;

bool unreserved(char character) {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') || character == '-' || character == '.' ||
           character == '_' || character == '~';
}

char hex_digit(unsigned value) { return static_cast<char>(value < 10 ? '0' + value : 'A' + value - 10); }

}  // namespace

bool HostyClient::configure(std::string_view origin, std::string_view access_token) {
    if (!origin_.assign(origin) || !access_token_.assign(access_token)) return false;
    secure_ = origin.starts_with("https://");
    if (request_lock_ == nullptr) {
        request_lock_ = xSemaphoreCreateMutex();
        if (request_lock_ == nullptr) return false;
    }
    return true;
}

void HostyClient::set_access_token(std::string_view access_token) {
    if (!access_token_.assign(access_token)) access_token_.clear();
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
    return request(HTTP_METHOD_POST, "/api/core/restart", "{}", true, nullptr);
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

HttpResult HostyClient::stream_events(EventStreamObserver& observer) const {
    hosty::FixedString<320> url;
    if (!make_url("/api/events", url)) return {ESP_ERR_INVALID_SIZE};

    esp_http_client_config_t config{};
    config.url = url.c_str();
    config.method = HTTP_METHOD_GET;
    // Comfortably past Core's 20-second keep-alive rather than 5 seconds past it: one heartbeat
    // delayed by a loaded host or a busy access point should not cost a reconnect and a full resync.
    // Liveness is enforced by kStreamSilenceLimitUs below, not by this timeout.
    config.timeout_ms = 45'000;
    config.buffer_size = 1024;
    config.buffer_size_tx = 512;
    config.keep_alive_enable = true;
    if (secure_) config.crt_bundle_attach = esp_crt_bundle_attach;

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == nullptr) return {ESP_ERR_NO_MEM};
    apply_common_headers(client, true, "text/event-stream");

    HttpResult result;
    result.transport_error = esp_http_client_open(client, 0);
    if (result.transport_error == ESP_OK) {
        const std::int64_t headers = esp_http_client_fetch_headers(client);
        result.status_code = esp_http_client_get_status_code(client);
        if (headers < 0) result.transport_error = static_cast<esp_err_t>(headers);
    }

    hosty::SseParser parser(observer);
    if (result.transport_error == ESP_OK && result.status_code >= 200 && result.status_code < 300) {
        observer.on_stream_connected();
        // esp_http_client_read() fills the requested length before returning. A
        // large destination therefore retains small SSE frames indefinitely
        // because Core's heartbeat arrives before the socket timeout. Reading
        // one byte at a time lets the streaming parser dispatch each frame as
        // soon as its terminating blank line arrives.
        char byte = 0;
        std::int64_t last_byte_us = esp_timer_get_time();
        while (true) {
            const int read = esp_http_client_read(client, &byte, 1);
            if (read > 0) {
                last_byte_us = esp_timer_get_time();
                if (parser.feed(std::string_view(&byte, 1)) != hosty::SseError::None) {
                    result.transport_error = ESP_FAIL;
                    break;
                }
                continue;
            }
            if (read == 0) break;
            if (read == -ESP_ERR_HTTP_EAGAIN || errno == EAGAIN) {
                // A socket timeout is indistinguishable from "nothing to read yet", so silence is the
                // only signal that the connection died without telling us — a NAT entry dropped, an
                // access point rebooted. Core sends a keep-alive comment every 20 seconds, so silence
                // well past that means the stream is gone and waiting for TCP keepalive to notice
                // would leave the console showing stale state in the meantime.
                if (esp_timer_get_time() - last_byte_us > kStreamSilenceLimitUs) {
                    ESP_LOGW(kTag, "Event stream silent for %lld s; reconnecting",
                             static_cast<long long>(kStreamSilenceLimitUs / 1'000'000));
                    result.transport_error = ESP_ERR_TIMEOUT;
                    break;
                }
                continue;
            }
            result.transport_error = ESP_FAIL;
            break;
        }
        if (result.transport_error == ESP_OK && parser.finish() != hosty::SseError::None) result.transport_error = ESP_FAIL;
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    observer.on_stream_closed(result);
    return result;
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

HttpResult HostyClient::request(esp_http_client_method_t method, std::string_view path, std::string_view body,
                                bool authenticated, hosty::ProtocolParserBase* parser, int timeout_ms) const {
    hosty::FixedString<320> url;
    if (!make_url(path, url)) return {ESP_ERR_INVALID_SIZE};
    ResponseContext context{parser, false};

    esp_http_client_config_t config{};
    config.url = url.c_str();
    config.method = method;
    config.timeout_ms = timeout_ms;
    config.buffer_size = 1024;
    config.buffer_size_tx = 512;
    config.keep_alive_enable = true;
    config.event_handler = &HostyClient::http_event;
    config.user_data = &context;
    if (secure_) config.crt_bundle_attach = esp_crt_bundle_attach;

    // One client per request, torn down when it returns — and only one at a time.
    //
    // A pooled, kept-alive connection was tried here and reverted: it cut a full sync from 5,990 ms to
    // 460 ms, but the device already keeps one TLS context alive permanently for the event stream, and
    // holding a second one across requests pushed mbedTLS into MBEDTLS_ERR_SSL_ALLOC_FAILED mid-read
    // (a 12.8 KB allocation refused) and starved xTaskCreate of a contiguous 10 KB for the sync task.
    // On 512 KB of internal SRAM with a 32 KB frame buffer and three task stacks, latency is the
    // cheaper thing to spend. Intermediate lifecycle states stay visible regardless, because the UI
    // predicts them locally instead of waiting for the round-trip.
    //
    // The lock is what survived that experiment, and it turned out to be the valuable half. Requests
    // come from the sync task and the command task independently, so without it a lifecycle POST and an
    // /api/apps GET perform their TLS handshakes simultaneously — three live contexts counting the
    // event stream, two certificate-bundle validations competing for the same heap. That fails as
    // ESP_ERR_HTTP_FETCH_HEADER after ten or fifteen seconds of retrying, on operations that take an
    // instant when they are allowed to run one after another.
    if (request_lock_ == nullptr) return {ESP_ERR_INVALID_STATE};
    xSemaphoreTake(request_lock_, portMAX_DELAY);

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == nullptr) {
        xSemaphoreGive(request_lock_);
        return {ESP_ERR_NO_MEM};
    }
    apply_common_headers(client, authenticated);
    if (!body.empty()) {
        esp_http_client_set_header(client, "Content-Type", "application/json");
        esp_http_client_set_post_field(client, body.data(), static_cast<int>(body.size()));
    }

    HttpResult result;
    result.transport_error = esp_http_client_perform(client);
    result.status_code = esp_http_client_get_status_code(client);
    if (result.transport_error == ESP_OK && result.status_code >= 200 && result.status_code < 300 && parser != nullptr) {
        result.protocol_error = parser->finish();
    } else if (context.parser_failed) {
        result.protocol_error = hosty::ProtocolError::Json;
    }
    if (!result.ok()) {
        ESP_LOGW(kTag, "%.*s %.*s failed: transport=%s status=%d protocol=%s heap-free=%u largest=%u",
                 static_cast<int>(method == HTTP_METHOD_GET ? 3 : method == HTTP_METHOD_POST ? 4 : 6),
                 method == HTTP_METHOD_GET ? "GET" : method == HTTP_METHOD_POST ? "POST" : "DELETE",
                 static_cast<int>(path.size()), path.data(), esp_err_to_name(result.transport_error), result.status_code,
                 hosty::protocol_error_name(result.protocol_error),
                 static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
    }
    esp_http_client_cleanup(client);
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
    }
}
