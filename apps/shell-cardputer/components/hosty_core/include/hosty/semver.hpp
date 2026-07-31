#pragma once

#include <cstdint>
#include <string_view>

namespace hosty {

struct SemanticVersion {
    std::uint32_t major = 0;
    std::uint32_t minor = 0;
    std::uint32_t patch = 0;
};

[[nodiscard]] bool parse_semantic_version(std::string_view value, SemanticVersion& result);
[[nodiscard]] int compare_semantic_versions(const SemanticVersion& left, const SemanticVersion& right);
[[nodiscard]] bool version_at_least(std::string_view actual, std::string_view minimum);

}  // namespace hosty

