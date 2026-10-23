#pragma once
#include "esp_err.h"
struct FakeHttp;
using esp_http_client_handle_t = FakeHttp*;
enum esp_http_client_method_t { HTTP_METHOD_GET, HTTP_METHOD_POST };
constexpr int HTTP_EVENT_ON_DATA = 1;
struct esp_http_client_event_t { int event_id; void* user_data; void* data; int data_len; };
struct esp_http_client_config_t {
 const char* url=nullptr; int buffer_size=0, buffer_size_tx=0;
 bool keep_alive_enable=false, disable_auto_redirect=false;
 esp_err_t (*event_handler)(esp_http_client_event_t*)=nullptr; void* user_data=nullptr;
 esp_err_t (*crt_bundle_attach)(void*)=nullptr;
};
esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t*);
esp_err_t esp_http_client_cleanup(esp_http_client_handle_t);
esp_err_t esp_http_client_set_url(esp_http_client_handle_t,const char*);
esp_err_t esp_http_client_set_method(esp_http_client_handle_t,esp_http_client_method_t);
esp_err_t esp_http_client_set_timeout_ms(esp_http_client_handle_t,int);
esp_err_t esp_http_client_set_header(esp_http_client_handle_t,const char*,const char*);
esp_err_t esp_http_client_delete_header(esp_http_client_handle_t,const char*);
esp_err_t esp_http_client_set_post_field(esp_http_client_handle_t,const char*,int);
esp_err_t esp_http_client_perform(esp_http_client_handle_t);
int esp_http_client_get_status_code(esp_http_client_handle_t);
