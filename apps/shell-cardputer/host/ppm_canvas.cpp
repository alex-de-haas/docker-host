#include "ppm_canvas.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>

namespace hosty::host {
namespace {

struct Glyph {
    char character;
    std::array<std::uint8_t, 5> columns;
};

constexpr Glyph kGlyphs[] = {
    {' ', {0, 0, 0, 0, 0}}, {'!', {0, 0, 0x5f, 0, 0}}, {'%', {0x63, 0x13, 0x08, 0x64, 0x63}},
    {'+', {0x08, 0x08, 0x3e, 0x08, 0x08}}, {',', {0, 0x50, 0x30, 0, 0}}, {'-', {0x08, 0x08, 0x08, 0x08, 0x08}},
    {'.', {0, 0x60, 0x60, 0, 0}}, {'/', {0x20, 0x10, 0x08, 0x04, 0x02}}, {':', {0, 0x36, 0x36, 0, 0}},
    {'0', {0x3e, 0x51, 0x49, 0x45, 0x3e}}, {'1', {0, 0x42, 0x7f, 0x40, 0}}, {'2', {0x42, 0x61, 0x51, 0x49, 0x46}},
    {'3', {0x21, 0x41, 0x45, 0x4b, 0x31}}, {'4', {0x18, 0x14, 0x12, 0x7f, 0x10}}, {'5', {0x27, 0x45, 0x45, 0x45, 0x39}},
    {'6', {0x3c, 0x4a, 0x49, 0x49, 0x30}}, {'7', {0x01, 0x71, 0x09, 0x05, 0x03}}, {'8', {0x36, 0x49, 0x49, 0x49, 0x36}},
    {'9', {0x06, 0x49, 0x49, 0x29, 0x1e}}, {'A', {0x7e, 0x11, 0x11, 0x11, 0x7e}}, {'B', {0x7f, 0x49, 0x49, 0x49, 0x36}},
    {'C', {0x3e, 0x41, 0x41, 0x41, 0x22}}, {'D', {0x7f, 0x41, 0x41, 0x22, 0x1c}}, {'E', {0x7f, 0x49, 0x49, 0x49, 0x41}},
    {'F', {0x7f, 0x09, 0x09, 0x09, 0x01}}, {'G', {0x3e, 0x41, 0x49, 0x49, 0x7a}}, {'H', {0x7f, 0x08, 0x08, 0x08, 0x7f}},
    {'I', {0, 0x41, 0x7f, 0x41, 0}}, {'J', {0x20, 0x40, 0x41, 0x3f, 0x01}}, {'K', {0x7f, 0x08, 0x14, 0x22, 0x41}},
    {'L', {0x7f, 0x40, 0x40, 0x40, 0x40}}, {'M', {0x7f, 0x02, 0x0c, 0x02, 0x7f}}, {'N', {0x7f, 0x04, 0x08, 0x10, 0x7f}},
    {'O', {0x3e, 0x41, 0x41, 0x41, 0x3e}}, {'P', {0x7f, 0x09, 0x09, 0x09, 0x06}}, {'Q', {0x3e, 0x41, 0x51, 0x21, 0x5e}},
    {'R', {0x7f, 0x09, 0x19, 0x29, 0x46}}, {'S', {0x46, 0x49, 0x49, 0x49, 0x31}}, {'T', {0x01, 0x01, 0x7f, 0x01, 0x01}},
    {'U', {0x3f, 0x40, 0x40, 0x40, 0x3f}}, {'V', {0x1f, 0x20, 0x40, 0x20, 0x1f}}, {'W', {0x3f, 0x40, 0x38, 0x40, 0x3f}},
    {'X', {0x63, 0x14, 0x08, 0x14, 0x63}}, {'Y', {0x07, 0x08, 0x70, 0x08, 0x07}}, {'Z', {0x61, 0x51, 0x49, 0x45, 0x43}},
    {'_', {0x40, 0x40, 0x40, 0x40, 0x40}}, {'|', {0, 0, 0x7f, 0, 0}}, {'?', {0x02, 0x01, 0x51, 0x09, 0x06}},
};

const std::array<std::uint8_t, 5>& columns_for(char character) {
    const char normalized = static_cast<char>(std::toupper(static_cast<unsigned char>(character)));
    for (const auto& glyph : kGlyphs) {
        if (glyph.character == normalized) return glyph.columns;
    }
    static constexpr std::array<std::uint8_t, 5> unknown{0x7f, 0x41, 0x49, 0x41, 0x7f};
    return unknown;
}

std::uint8_t expand5(std::uint16_t value) { return static_cast<std::uint8_t>((value * 255U + 15U) / 31U); }
std::uint8_t expand6(std::uint16_t value) { return static_cast<std::uint8_t>((value * 255U + 31U) / 63U); }

}  // namespace

void PpmCanvas::fill(Color color) { pixels_.fill(color); }

void PpmCanvas::fill_rect(int x, int y, int width, int height, Color color) {
    const int left = std::max(0, x);
    const int top = std::max(0, y);
    const int right = std::min(kWidth, x + width);
    const int bottom = std::min(kHeight, y + height);
    for (int row = top; row < bottom; ++row) {
        for (int column = left; column < right; ++column) pixel(column, row, color);
    }
}

void PpmCanvas::text(int x, int y, std::string_view value, Color foreground, Color background) {
    int cursor = x;
    for (const char character : value) {
        if (cursor + 5 >= kWidth) break;
        glyph(cursor, y, character, foreground, background);
        cursor += 6;
    }
}

bool PpmCanvas::write(const std::string& path) const {
    std::ofstream output(path, std::ios::binary);
    if (!output) return false;
    output << "P6\n" << kWidth << ' ' << kHeight << "\n255\n";
    for (const Color color : pixels_) {
        const char rgb[] = {
            static_cast<char>(expand5((color >> 11U) & 0x1FU)),
            static_cast<char>(expand6((color >> 5U) & 0x3FU)),
            static_cast<char>(expand5(color & 0x1FU)),
        };
        output.write(rgb, sizeof(rgb));
    }
    return static_cast<bool>(output);
}

std::uint64_t PpmCanvas::checksum() const {
    std::uint64_t hash = 1469598103934665603ULL;
    for (const Color pixel_value : pixels_) {
        hash ^= pixel_value;
        hash *= 1099511628211ULL;
    }
    return hash;
}

void PpmCanvas::pixel(int x, int y, Color color) {
    if (x >= 0 && x < kWidth && y >= 0 && y < kHeight) pixels_[static_cast<std::size_t>(y * kWidth + x)] = color;
}

void PpmCanvas::glyph(int x, int y, char character, Color foreground, Color background) {
    const auto& columns = columns_for(character);
    for (int column = 0; column < 5; ++column) {
        for (int row = 0; row < 7; ++row) {
            pixel(x + column, y + row, (columns[column] & (1U << row)) != 0 ? foreground : background);
        }
    }
    for (int row = 0; row < 7; ++row) pixel(x + 5, y + row, background);
}

}  // namespace hosty::host

