#pragma once

#include "hosty/render.hpp"

#include <array>
#include <cstdint>
#include <string>

namespace hosty::host {

class PpmCanvas final : public Canvas {
public:
    static constexpr int kWidth = 240;
    static constexpr int kHeight = 135;

    [[nodiscard]] int width() const override { return kWidth; }
    [[nodiscard]] int height() const override { return kHeight; }
    void fill(Color color) override;
    void fill_rect(int x, int y, int width, int height, Color color) override;
    void text(int x, int y, std::string_view value, Color foreground, Color background) override;
    void text_scaled(int x, int y, std::string_view value, Color foreground, Color background,
                     std::uint8_t scale) override;

    [[nodiscard]] bool write(const std::string& path) const;
    [[nodiscard]] std::uint64_t checksum() const;

private:
    void pixel(int x, int y, Color color);

    std::array<Color, kWidth * kHeight> pixels_{};
};

}  // namespace hosty::host

