idf_component_register(
    SRCS
        "src/auth.cpp"
        "src/endpoint.cpp"
        "src/json_stream.cpp"
        "src/power.cpp"
        "src/protocol.cpp"
        "src/render.cpp"
        "src/semver.cpp"
        "src/sse.cpp"
        "src/state.cpp"
    INCLUDE_DIRS "include"
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_20)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
