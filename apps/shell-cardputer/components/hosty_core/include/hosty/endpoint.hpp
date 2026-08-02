#pragma once

#include "hosty/bounded.hpp"

#include <cstdint>
#include <string_view>

namespace hosty {

enum class EndpointError : std::uint8_t {
    None,
    TooLong,
    InvalidScheme,
    MissingHost,
    InvalidPort,
    CredentialsNotAllowed,
    PathNotAllowed,
    PublicHttpNotAllowed,
};

struct ValidatedEndpoint {
    FixedString<192> origin;
    FixedString<128> host;
    bool secure = false;
    bool local_network = false;
};

[[nodiscard]] EndpointError validate_core_origin(std::string_view input, ValidatedEndpoint& output);
[[nodiscard]] const char* endpoint_error_name(EndpointError error);

}  // namespace hosty
