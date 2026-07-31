idf_component_register(
    SRCS
        "app_main.cpp"
        "firmware_app.cpp"
        "firmware_ota.cpp"
        "hosty_client.cpp"
        "settings_store.cpp"
        "wifi_manager.cpp"
    INCLUDE_DIRS "."
    REQUIRES
        app_update
        cardputer_hal
        esp_event
        esp_http_client
        esp_https_ota
        esp_netif
        esp_pm
        esp_timer
        esp_wifi
        hosty_core
        json
        nvs_flash
        lwip
        mbedtls
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_20)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
