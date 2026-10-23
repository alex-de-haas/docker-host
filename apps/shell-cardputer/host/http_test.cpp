#include "hosty_client.hpp"
#include <cstdlib>
#include <deque>
#include <iostream>
#include <map>
#include <string>
#include <vector>
#define CHECK(x) do { if (!(x)) { std::cerr << __LINE__ << ": " #x "\n"; std::exit(1); } } while(false)
struct Reply { int status=200; std::string body="{}"; int error=ESP_OK; };
struct Request { std::string url, body; esp_http_client_method_t method; std::map<std::string,std::string> headers; };
struct FakeHttp {
 esp_http_client_config_t config; Request request; int status=0;
};
std::deque<Reply> replies;
std::vector<Request> requests;
int created=0, destroyed=0;
std::int64_t clock_us=1000000;
std::int64_t esp_timer_get_time() { return clock_us; }
void vTaskDelay(int ms) { clock_us += ms*1000LL; }
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t* cfg) {
 CHECK(cfg->disable_auto_redirect);
 CHECK(cfg->crt_bundle_attach != nullptr);
 ++created; auto* client=new FakeHttp; client->config=*cfg; client->request.url=cfg->url; return client;
}
esp_err_t esp_http_client_cleanup(FakeHttp* c) { ++destroyed; delete c; return ESP_OK; }
esp_err_t esp_http_client_set_url(FakeHttp* c,const char* s) { c->request.url=s; return ESP_OK; }
esp_err_t esp_http_client_set_method(FakeHttp* c,esp_http_client_method_t m) { c->request.method=m; return ESP_OK; }
esp_err_t esp_http_client_set_timeout_ms(FakeHttp*,int) { return ESP_OK; }
esp_err_t esp_http_client_set_header(FakeHttp* c,const char* k,const char* v) { c->request.headers[k]=v; return ESP_OK; }
esp_err_t esp_http_client_delete_header(FakeHttp* c,const char* k) { c->request.headers.erase(k); return ESP_OK; }
esp_err_t esp_http_client_set_post_field(FakeHttp* c,const char* p,int n) { c->request.body=p ? std::string(p,n) : ""; if (!p && !c->request.headers.erase("Content-Type")) return ESP_ERR_NOT_FOUND; return ESP_OK; }
int esp_http_client_get_status_code(FakeHttp* c) { return c->status; }
esp_err_t esp_http_client_perform(FakeHttp* c) {
 CHECK(!replies.empty()); auto reply=replies.front(); replies.pop_front(); requests.push_back(c->request);
 c->status=reply.status;
 if (reply.error != ESP_OK) return reply.error;
 for (auto& byte : reply.body) {
  esp_http_client_event_t event{HTTP_EVENT_ON_DATA,c->config.user_data,&byte,1};
  if (c->config.event_handler(&event) != ESP_OK) return ESP_FAIL;
 }
 return ESP_OK;
}
int main() {
 HostyClient client;
 CHECK(client.configure("https://core.example.test","token-one"));
 replies.push_back({204,""});
 CHECK(client.set_autostart("app /one",true).ok());
 CHECK(requests.back().body == R"({"autostart":true})");
 CHECK(requests.back().url.ends_with("/api/apps/app%20%2Fone/autostart"));
 replies.push_back({200,R"({"status":"running","version":"0.150.2"})"});
 hosty::CoreSnapshot snapshot;
 CHECK(client.read_core_status(snapshot).ok());
 CHECK(snapshot.version == "0.150.2");
 CHECK(created == 1); // Sequential POST and GET share exactly one TLS handle.
 CHECK(requests.back().body.empty());
 CHECK(!requests.back().headers.contains("Content-Type"));
 CHECK(requests.back().headers.at("Authorization") == "Bearer token-one");
 replies.push_back({200,R"({"status":"pending"})"});
 hosty::DeviceTokenResult token;
 CHECK(client.poll_device_token("device",token).ok());
 CHECK(!requests.back().headers.contains("Authorization"));
 CHECK(created == 1);
 client.release_if_idle(5999); CHECK(destroyed == 0);
 client.release_if_idle(6000); CHECK(destroyed == 1);

 replies.push_back({0,"",ESP_ERR_TIMEOUT});
 const auto before=requests.size();
 CHECK(!client.app_lifecycle("app","start").ok());
 CHECK(requests.size() == before+1); // An uncertain mutation is never replayed.
 CHECK(destroyed == 2);
 replies.push_back({200,R"({"status":"running","version":"0.150.2"})"});
 CHECK(client.read_core_status(snapshot).ok()); CHECK(created == 3);
 replies.push_back({200,R"({"version":)"});
 CHECK(!client.read_core_status(snapshot).ok()); CHECK(destroyed == 3);
 client.set_access_token("token-two");
 replies.push_back({401,"{}"});
 CHECK(client.read_core_status(snapshot).unauthorized()); CHECK(destroyed == 4);

 replies.push_back({200,R"({"instance":"22:33","source":{"revision":"revision"}})"});
 replies.push_back({202,R"({"status":"accepted"})"});
 replies.push_back({200,R"({"status":"building"})"});
 replies.push_back({200,R"({"status":"completed"})"});
 CHECK(client.restart_core().ok());
 const auto& restart=requests[requests.size()-3];
 CHECK(restart.body.find(R"("instance":"22:33")") != std::string::npos);
 CHECK(restart.body.find(R"("sourceRevision":"revision")") != std::string::npos);
 CHECK(requests.back().url.ends_with("/api/core/operations/12345678123456781234567812345678"));
 CHECK(replies.empty());
 client.release(); CHECK(created == destroyed);
 std::cout << "Cardputer HTTP reuse, isolation, failures and Core restart tests passed\n";
}
