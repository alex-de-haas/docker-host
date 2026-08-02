#pragma once

#include "hosty/bounded.hpp"

#include <cstdint>
#include <string_view>

namespace hosty {

struct SemanticVersion {
    std::uint32_t major = 0;
    std::uint32_t minor = 0;
    std::uint32_t patch = 0;
    // Kept, not discarded. Dropping it made 0.1.0-alpha compare equal to 0.1.0, which let OTA accept a
    // prerelease over the release it claims to protect against downgrading from, and let a prerelease
    // Core satisfy a minimum stated as final. Build metadata (`+...`) is still ignored: SemVer says it
    // takes no part in precedence.
    FixedString<48> prerelease;
};

[[nodiscard]] bool parse_semantic_version(std::string_view value, SemanticVersion& result);
[[nodiscard]] int compare_semantic_versions(const SemanticVersion& left, const SemanticVersion& right);
[[nodiscard]] bool version_at_least(std::string_view actual, std::string_view minimum);

}  // namespace hosty

