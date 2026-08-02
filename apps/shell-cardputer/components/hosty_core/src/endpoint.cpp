#include "hosty/endpoint.hpp"

namespace hosty {
namespace {

bool parse_octet(std::string_view value, unsigned& octet) {
    if (value.empty() || value.size() > 3) return false;
    unsigned parsed = 0;
    for (const char character : value) {
        if (character < '0' || character > '9') return false;
        parsed = parsed * 10U + static_cast<unsigned>(character - '0');
    }
    if (parsed > 255) return false;
    octet = parsed;
    return true;
}

bool private_ipv4(std::string_view host) {
    unsigned parts[4]{};
    std::size_t start = 0;
    for (int index = 0; index < 4; ++index) {
        const std::size_t end = index == 3 ? host.size() : host.find('.', start);
        if (end == std::string_view::npos || !parse_octet(host.substr(start, end - start), parts[index])) return false;
        start = end + 1;
    }
    return parts[0] == 10 || parts[0] == 127 ||
           (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31) ||
           (parts[0] == 192 && parts[1] == 168) ||
           (parts[0] == 169 && parts[1] == 254);
}

bool ends_with(std::string_view value, std::string_view suffix) {
    return value.size() >= suffix.size() && value.substr(value.size() - suffix.size()) == suffix;
}

bool valid_port(std::string_view value) {
    if (value.empty() || value.size() > 5) return false;
    unsigned port = 0;
    for (const char character : value) {
        if (character < '0' || character > '9') return false;
        port = port * 10U + static_cast<unsigned>(character - '0');
    }
    return port > 0 && port <= 65'535;
}

}  // namespace

EndpointError validate_core_origin(std::string_view input, ValidatedEndpoint& output) {
    output = {};
    while (!input.empty() && (input.front() == ' ' || input.front() == '\t')) input.remove_prefix(1);
    while (!input.empty() && (input.back() == ' ' || input.back() == '\t' || input.back() == '/')) input.remove_suffix(1);
    if (input.size() > output.origin.capacity()) return EndpointError::TooLong;

    constexpr std::string_view https = "https://";
    constexpr std::string_view http = "http://";
    std::size_t scheme_length = 0;
    if (input.starts_with(https)) {
        output.secure = true;
        scheme_length = https.size();
    } else if (input.starts_with(http)) {
        scheme_length = http.size();
    } else {
        return EndpointError::InvalidScheme;
    }

    const std::string_view authority = input.substr(scheme_length);
    if (authority.empty()) return EndpointError::MissingHost;
    if (authority.find('@') != std::string_view::npos) return EndpointError::CredentialsNotAllowed;
    if (authority.find_first_of("/?#") != std::string_view::npos) return EndpointError::PathNotAllowed;

    std::string_view host = authority;
    if (host.front() == '[') {
        const std::size_t closing = host.find(']');
        if (closing == std::string_view::npos) return EndpointError::MissingHost;
        const std::string_view remainder = host.substr(closing + 1);
        if (!remainder.empty() && (remainder.front() != ':' || !valid_port(remainder.substr(1)))) {
            return EndpointError::InvalidPort;
        }
        host = host.substr(1, closing - 1);
        output.local_network = host == "::1" || host.starts_with("fe80:") || host.starts_with("fc") || host.starts_with("fd");
    } else {
        const std::size_t colon = host.rfind(':');
        if (colon != std::string_view::npos) {
            if (!valid_port(host.substr(colon + 1))) return EndpointError::InvalidPort;
            host = host.substr(0, colon);
        }
        if (host.empty()) return EndpointError::MissingHost;
        // Deliberately not "any name without a dot". A bare label such as `core` says nothing about
        // where it resolves: a DNS search suffix or a rebinding answer can put it on a public address,
        // and this device would then send a full administrator bearer token there in the clear. What
        // remains are names whose address is settled by definition — loopback, mDNS link-local, and
        // literal private IPv4. A LAN host reachable only by a single-label name is still usable over
        // plain HTTP by its address, and over HTTPS by any name at all.
        output.local_network = host == "localhost" || ends_with(host, ".local") || private_ipv4(host);
    }
    if (!output.secure && !output.local_network) return EndpointError::PublicHttpNotAllowed;
    if (!output.origin.assign(input) || !output.host.assign(host)) return EndpointError::TooLong;
    return EndpointError::None;
}

const char* endpoint_error_name(EndpointError error) {
    switch (error) {
        case EndpointError::None: return "none";
        case EndpointError::TooLong: return "too_long";
        case EndpointError::InvalidScheme: return "invalid_scheme";
        case EndpointError::MissingHost: return "missing_host";
        case EndpointError::InvalidPort: return "invalid_port";
        case EndpointError::CredentialsNotAllowed: return "credentials_not_allowed";
        case EndpointError::PathNotAllowed: return "path_not_allowed";
        case EndpointError::PublicHttpNotAllowed: return "public_http_not_allowed";
    }
    return "unknown";
}

}  // namespace hosty
