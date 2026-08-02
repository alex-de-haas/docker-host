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
    // Build metadata is dropped — SemVer says it never affects precedence. The prerelease is kept.
    const std::size_t build = value.find('+');
    if (build != std::string_view::npos) value = value.substr(0, build);

    std::string_view prerelease;
    const std::size_t dash = value.find('-');
    if (dash != std::string_view::npos) {
        prerelease = value.substr(dash + 1);
        value = value.substr(0, dash);
        if (prerelease.empty()) return false;
    }

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
    // A prerelease longer than the field is refused rather than silently shortened: a truncated
    // identifier would compare as a different, plausible-looking version.
    if (!parsed.prerelease.assign(prerelease)) return false;
    result = parsed;
    return true;
}

namespace {

bool numeric_identifier(std::string_view value) {
    if (value.empty()) return false;
    for (const char character : value) {
        if (character < '0' || character > '9') return false;
    }
    return true;
}

// SemVer precedence for one dot-separated identifier: numeric ones compare numerically, alphanumeric
// ones compare in ASCII order, and a numeric identifier always ranks below an alphanumeric one.
int compare_identifier(std::string_view left, std::string_view right) {
    const bool left_numeric = numeric_identifier(left);
    const bool right_numeric = numeric_identifier(right);
    if (left_numeric != right_numeric) return left_numeric ? -1 : 1;
    if (left_numeric) {
        // Compare by length first so 2 < 10 despite "10" sorting before "2" lexically. Leading zeros
        // are not valid in a numeric identifier, so equal length means a straight comparison holds.
        if (left.size() != right.size()) return left.size() < right.size() ? -1 : 1;
    }
    if (left == right) return 0;
    return left < right ? -1 : 1;
}

// Walks both prerelease strings identifier by identifier. When everything shared is equal, the shorter
// list ranks lower: 1.0.0-alpha precedes 1.0.0-alpha.1.
int compare_prerelease(std::string_view left, std::string_view right) {
    if (left.empty() && right.empty()) return 0;
    // A version with no prerelease outranks one that has any.
    if (left.empty()) return 1;
    if (right.empty()) return -1;

    while (!left.empty() || !right.empty()) {
        if (left.empty()) return -1;
        if (right.empty()) return 1;

        const std::size_t left_dot = left.find('.');
        const std::size_t right_dot = right.find('.');
        const std::string_view left_part = left.substr(0, left_dot);
        const std::string_view right_part = right.substr(0, right_dot);

        const int identifier = compare_identifier(left_part, right_part);
        if (identifier != 0) return identifier;

        left = left_dot == std::string_view::npos ? std::string_view{} : left.substr(left_dot + 1);
        right = right_dot == std::string_view::npos ? std::string_view{} : right.substr(right_dot + 1);
    }
    return 0;
}

}  // namespace

int compare_semantic_versions(const SemanticVersion& left, const SemanticVersion& right) {
    if (left.major != right.major) return left.major < right.major ? -1 : 1;
    if (left.minor != right.minor) return left.minor < right.minor ? -1 : 1;
    if (left.patch != right.patch) return left.patch < right.patch ? -1 : 1;
    return compare_prerelease(left.prerelease.view(), right.prerelease.view());
}

bool version_at_least(std::string_view actual, std::string_view minimum) {
    SemanticVersion actual_version;
    SemanticVersion minimum_version;
    return parse_semantic_version(actual, actual_version) &&
           parse_semantic_version(minimum, minimum_version) &&
           compare_semantic_versions(actual_version, minimum_version) >= 0;
}

}  // namespace hosty

