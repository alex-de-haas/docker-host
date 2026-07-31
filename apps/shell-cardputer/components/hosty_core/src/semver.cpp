#include "hosty/semver.hpp"

#include <limits>

namespace hosty {
namespace {

bool parse_part(std::string_view part, std::uint32_t& output) {
    if (part.empty()) return false;
    std::uint64_t value = 0;
    for (const char character : part) {
        if (character < '0' || character > '9') return false;
        value = value * 10U + static_cast<unsigned>(character - '0');
        if (value > std::numeric_limits<std::uint32_t>::max()) return false;
    }
    output = static_cast<std::uint32_t>(value);
    return true;
}

}  // namespace

bool parse_semantic_version(std::string_view value, SemanticVersion& result) {
    const std::size_t metadata = value.find_first_of("-+");
    if (metadata != std::string_view::npos) value = value.substr(0, metadata);

    const std::size_t first = value.find('.');
    if (first == std::string_view::npos) return false;
    const std::size_t second = value.find('.', first + 1);
    if (second == std::string_view::npos || value.find('.', second + 1) != std::string_view::npos) return false;

    SemanticVersion parsed;
    if (!parse_part(value.substr(0, first), parsed.major) ||
        !parse_part(value.substr(first + 1, second - first - 1), parsed.minor) ||
        !parse_part(value.substr(second + 1), parsed.patch)) {
        return false;
    }
    result = parsed;
    return true;
}

int compare_semantic_versions(const SemanticVersion& left, const SemanticVersion& right) {
    if (left.major != right.major) return left.major < right.major ? -1 : 1;
    if (left.minor != right.minor) return left.minor < right.minor ? -1 : 1;
    if (left.patch != right.patch) return left.patch < right.patch ? -1 : 1;
    return 0;
}

bool version_at_least(std::string_view actual, std::string_view minimum) {
    SemanticVersion actual_version;
    SemanticVersion minimum_version;
    return parse_semantic_version(actual, actual_version) &&
           parse_semantic_version(minimum, minimum_version) &&
           compare_semantic_versions(actual_version, minimum_version) >= 0;
}

}  // namespace hosty

