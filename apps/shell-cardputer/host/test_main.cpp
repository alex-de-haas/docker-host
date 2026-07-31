#include "hosty/auth.hpp"
#include "hosty/endpoint.hpp"
#include "hosty/json_stream.hpp"
#include "hosty/power.hpp"
#include "hosty/protocol.hpp"
#include "hosty/render.hpp"
#include "hosty/semver.hpp"
#include "hosty/sse.hpp"
#include "hosty/state.hpp"
#include "ppm_canvas.hpp"

#include <algorithm>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#ifndef HOSTY_FIXTURE_DIR
#define HOSTY_FIXTURE_DIR "fixtures"
#endif

namespace {

int failures = 0;

#define CHECK(condition) do { if (!(condition)) { std::cerr << __FILE__ << ':' << __LINE__ << " check failed: " #condition "\n"; ++failures; } } while (false)

std::string read_fixture(const char* name) {
    std::ifstream input(std::string(HOSTY_FIXTURE_DIR) + "/" + name, std::ios::binary);
    std::ostringstream buffer;
    buffer << input.rdbuf();
    return buffer.str();
}

template <typename Parser>
hosty::ProtocolError feed_chunked(Parser& parser, std::string_view document, std::size_t chunk_size) {
    for (std::size_t offset = 0; offset < document.size(); offset += chunk_size) {
        const auto length = std::min(chunk_size, document.size() - offset);
        if (parser.feed(document.substr(offset, length)) != hosty::JsonError::None) break;
    }
    return parser.finish();
}

class CollectSse final : public hosty::SseListener {
public:
    bool on_sse_event(const hosty::SseEvent& event) override {
        name = event.name;
        data = event.data;
        ++count;
        return true;
    }
    std::string name;
    std::string data;
    int count = 0;
};

class AcceptJson final : public hosty::JsonListener {
public:
    bool on_json_event(const hosty::JsonEvent&) override { return true; }
};

void test_json_number_syntax() {
    for (const std::string_view valid : {"0", "-1", "12.5", "1e9", "-2.5E-3"}) {
        AcceptJson listener;
        hosty::JsonStreamParser parser(listener);
        CHECK(parser.feed(valid) == hosty::JsonError::None);
        CHECK(parser.finish() == hosty::JsonError::None);
    }
    for (const std::string_view invalid : {"01", "-", "1.", "1e", "1+2"}) {
        AcceptJson listener;
        hosty::JsonStreamParser parser(listener);
        static_cast<void>(parser.feed(invalid));
        CHECK(parser.finish() != hosty::JsonError::None);
    }

    for (const std::string_view trailing_comma : {"[1,]", "{\"a\":1,}"}) {
        AcceptJson listener;
        hosty::JsonStreamParser parser(listener);
        static_cast<void>(parser.feed(trailing_comma));
        CHECK(parser.finish() != hosty::JsonError::None);
    }
}

void test_semver() {
    CHECK(hosty::version_at_least("0.73.0", "0.73.0"));
    CHECK(hosty::version_at_least("0.74.1+abc", "0.73.0"));
    CHECK(!hosty::version_at_least("0.72.9", "0.73.0"));
    CHECK(!hosty::version_at_least("not-a-version", "0.73.0"));
}

void test_endpoint_validation() {
    hosty::ValidatedEndpoint endpoint;
    CHECK(hosty::validate_core_origin("https://hosty.example/", endpoint) == hosty::EndpointError::None);
    CHECK(endpoint.origin == "https://hosty.example");
    CHECK(endpoint.secure);
    CHECK(hosty::validate_core_origin("http://192.168.1.10:5080", endpoint) == hosty::EndpointError::None);
    CHECK(endpoint.local_network);
    CHECK(hosty::validate_core_origin("http://hosty.local", endpoint) == hosty::EndpointError::None);
    CHECK(hosty::validate_core_origin("http://public.example", endpoint) == hosty::EndpointError::PublicHttpNotAllowed);
    CHECK(hosty::validate_core_origin("https://user:pass@hosty.example", endpoint) == hosty::EndpointError::CredentialsNotAllowed);
    CHECK(hosty::validate_core_origin("https://hosty.example/path", endpoint) == hosty::EndpointError::PathNotAllowed);
    CHECK(hosty::validate_core_origin("http://hosty.local:abc", endpoint) == hosty::EndpointError::InvalidPort);
    CHECK(hosty::validate_core_origin("https://hosty.example:70000", endpoint) == hosty::EndpointError::InvalidPort);
}

void test_device_flow() {
    constexpr std::string_view code_json = R"({"deviceCode":"device-secret","userCode":"ABCD-EFGH","verificationUri":"https://host/shell/settings?tab=tokens","intervalSeconds":3,"expiresInSeconds":600})";
    hosty::DeviceCode code;
    hosty::DeviceCodeParser code_parser(code);
    CHECK(feed_chunked(code_parser, code_json, 1) == hosty::ProtocolError::None);
    CHECK(code.user_code == "ABCD-EFGH");
    CHECK(code.interval_seconds == 3);

    hosty::Enrollment enrollment;
    enrollment.start(1'000);
    CHECK(enrollment.accept_code(code, 1'000));
    CHECK(!enrollment.poll_due(3'999));
    CHECK(enrollment.poll_due(4'000));

    hosty::DeviceTokenResult pending;
    hosty::DeviceTokenParser pending_parser(pending);
    CHECK(feed_chunked(pending_parser, R"({"status":"pending","token":null})", 2) == hosty::ProtocolError::None);
    enrollment.accept_token_result(pending, 4'000);
    CHECK(!enrollment.poll_due(6'999));

    hosty::DeviceTokenResult approved;
    hosty::DeviceTokenParser approved_parser(approved);
    CHECK(feed_chunked(approved_parser, R"({"status":"approved","token":"hosty-token"})", 5) == hosty::ProtocolError::None);
    enrollment.accept_token_result(approved, 7'000);
    CHECK(enrollment.state() == hosty::EnrollmentState::Approved);
    CHECK(enrollment.token() == "hosty-token");
}

void test_session() {
    hosty::SessionInfo session;
    hosty::SessionParser parser(session);
    constexpr std::string_view json = R"({"authenticated":true,"user":{"id":"user_1","displayName":"Admin \u0410","role":"host.admin","disabled":false},"kind":"device"})";
    CHECK(feed_chunked(parser, json, 3) == hosty::ProtocolError::None);
    CHECK(session.authenticated);
    CHECK(session.administrator);
    CHECK(session.credential_kind == "device");
    CHECK(session.display_name.view().find("Admin") == 0);
}

void test_core_update_status() {
    hosty::CoreSnapshot snapshot;
    hosty::CoreUpdateStatusParser parser(snapshot);
    constexpr std::string_view json = R"({"currentVersion":"0.73.0","updateAvailable":true,"releaseTag":"cli-dev","checkedAt":"2026-07-31T12:00:00Z","error":null})";
    CHECK(feed_chunked(parser, json, 4) == hosty::ProtocolError::None);
    CHECK(snapshot.core_update.known);
    CHECK(snapshot.core_update.available);
}

void test_apps_fixture() {
    const std::string json = read_fixture("apps-50.json");
    CHECK(!json.empty());
    for (const std::size_t chunk : {1U, 7U, 127U, 1024U}) {
        hosty::CoreSnapshot snapshot;
        hosty::AppsResponseParser parser(snapshot);
        CHECK(feed_chunked(parser, json, chunk) == hosty::ProtocolError::None);
        CHECK(snapshot.apps.size() == 50);
        CHECK(snapshot.apps[0].id == "com.example.app-01");
        CHECK(snapshot.apps[1].runtime_state == hosty::RuntimeState::Unknown);
        CHECK(snapshot.apps[2].update.available);
        CHECK(snapshot.apps[2].update.plan_digest == "sha256:plan-03");
        CHECK(snapshot.apps[3].update.requires_review);
        CHECK(snapshot.update_check.known);
    }
}

void test_app_collection_limit() {
    std::string json = "{\"apps\":[";
    for (int index = 0; index < 65; ++index) {
        if (index != 0) json += ',';
        json += "{\"id\":\"app-" + std::to_string(index) + "\",\"runtimeState\":\"stopped\"}";
    }
    json += "]}";
    hosty::CoreSnapshot snapshot;
    hosty::AppsResponseParser parser(snapshot);
    CHECK(feed_chunked(parser, json, 31) == hosty::ProtocolError::TooManyItems);
    CHECK(snapshot.apps.size() == hosty::kMaximumApps);
}

void test_notifications() {
    constexpr std::string_view json = R"({"notifications":[{"id":"n1","source":{"kind":"app","appId":"com.example.app"},"audience":"user","level":"warning","title":"Disk almost full","body":"Clean up soon","createdAt":"2026-07-31T12:00:00Z","read":false}],"unreadCount":1,"pagination":{"limit":20,"offset":0,"total":1},"updatedAt":"2026-07-31T12:00:00Z"})";
    hosty::NotificationSnapshot notifications;
    hosty::NotificationsParser parser(notifications);
    CHECK(feed_chunked(parser, json, 11) == hosty::ProtocolError::None);
    CHECK(notifications.items.size() == 1);
    CHECK(notifications.unread_count == 1);
    CHECK(notifications.items[0].level == hosty::NotificationLevel::Warning);
    CHECK(notifications.items[0].app_id == "com.example.app");
}

void test_log_tail_is_bounded() {
    hosty::LogTail logs;
    hosty::LogTailParser parser(logs);
    constexpr std::string_view json = R"({"appId":"com.example","text":"one\ntwo","services":[]})";
    CHECK(feed_chunked(parser, json, 2) == hosty::ProtocolError::None);
    CHECK(logs.app_id == "com.example");
    CHECK(logs.text == "one\ntwo");
}

void test_sse() {
    CollectSse listener;
    hosty::SseParser parser(listener);
    constexpr std::string_view stream = ": connected\n\nevent: app.changed\ndata: {\"appId\":\"com.example\"}\n\nevent: notification\ndata: line one\ndata: line two\n\n";
    for (const char character : stream) CHECK(parser.feed(std::string_view(&character, 1)) == hosty::SseError::None);
    CHECK(parser.finish() == hosty::SseError::None);
    CHECK(listener.count == 2);
    CHECK(listener.name == "notification");
    CHECK(listener.data == "line one\nline two");
}

void test_state_and_power() {
    hosty::ClientState state;
    state.apply({hosty::ConnectionEvent::Type::Configured, 0});
    state.apply({hosty::ConnectionEvent::Type::WifiConnected, 10});
    state.apply({hosty::ConnectionEvent::Type::TimeReady, 20});
    state.apply({hosty::ConnectionEvent::Type::SyncCompleted, 30});
    CHECK(state.connection() == hosty::ConnectionState::Online);
    CHECK(state.on_sse_event("app.changed") == hosty::SyncHint::Apps);
    CHECK(state.on_sse_event("future.event") == hosty::SyncHint::None);
    state.apply({hosty::ConnectionEvent::Type::TransportFailed, 40});
    CHECK(state.connection() == hosty::ConnectionState::Stale);

    hosty::PowerPolicy policy;
    policy.display_timeout_ms = 1000;
    policy.motion_cooldown_ms = 500;
    policy.motion_threshold_mg = 100;
    hosty::PowerController power(policy);
    CHECK(power.tick(999, false, 0).display_off == false);
    CHECK(power.tick(1000, false, 0).display_off);
    CHECK(power.mode() == hosty::PowerMode::OnlineStandby);
    CHECK(power.tick(1100, false, 120).display_on);
    CHECK(power.notification(1200, hosty::NotificationLevel::Info, false).play_sound);
    CHECK(power.request_deep_standby().enter_deep_sleep);
    CHECK(power.tick(1300, true, 0).leave_deep_sleep);
}

void test_render() {
    hosty::CoreSnapshot snapshot;
    snapshot.version.assign_truncated("0.73.0");
    hosty::AppSummary app;
    app.id.assign_truncated("com.example");
    app.display_name.assign_truncated("Example");
    app.runtime_state = hosty::RuntimeState::Running;
    app.operation_state = hosty::OperationState::Idle;
    CHECK(snapshot.apps.push_back(app));
    hosty::ClientState state;
    state.install_snapshot(snapshot, 10);
    state.apply({hosty::ConnectionEvent::Type::SyncCompleted, 10});
    hosty::UiState ui;
    ui.battery_percent = 90;
    hosty::host::PpmCanvas canvas;
    hosty::Renderer renderer;
    renderer.render(canvas, state, ui);
    CHECK(canvas.checksum() != 0);
}

}  // namespace

int main() {
    test_json_number_syntax();
    test_semver();
    test_endpoint_validation();
    test_device_flow();
    test_session();
    test_core_update_status();
    test_apps_fixture();
    test_app_collection_limit();
    test_notifications();
    test_log_tail_is_bounded();
    test_sse();
    test_state_and_power();
    test_render();
    if (failures != 0) {
        std::cerr << failures << " host test(s) failed\n";
        return 1;
    }
    std::cout << "Hosty Cardputer host tests passed\n";
    return 0;
}
