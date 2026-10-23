#pragma once
#include <cstdint>
namespace hosty {
// Never bootstrap HTTPS with an unset clock or a date older than this image.
[[nodiscard]] constexpr bool clock_valid(std::int64_t now, std::int64_t build_epoch) {
    return build_epoch > 0 && now >= build_epoch;
}
}  // namespace hosty
