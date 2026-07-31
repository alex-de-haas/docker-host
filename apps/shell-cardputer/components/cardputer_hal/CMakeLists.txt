idf_component_register(
    SRCS
        "src/cardputer_hardware.cpp"
        "src/tca8418_keyboard.cpp"
    INCLUDE_DIRS "include"
    REQUIRES driver hosty_core m5unified
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_20)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)

