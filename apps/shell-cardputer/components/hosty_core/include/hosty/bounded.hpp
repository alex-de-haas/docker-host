#pragma once

#include <array>
#include <cstddef>
#include <string_view>
#include <utility>

namespace hosty {

template <std::size_t Capacity>
class FixedString {
public:
    constexpr FixedString() = default;
    constexpr explicit FixedString(std::string_view value) { assign_truncated(value); }

    [[nodiscard]] constexpr bool assign(std::string_view value) {
        if (value.size() > Capacity) {
            clear();
            return false;
        }
        size_ = value.size();
        for (std::size_t index = 0; index < size_; ++index) {
            data_[index] = value[index];
        }
        data_[size_] = '\0';
        return true;
    }

    constexpr void assign_truncated(std::string_view value) {
        size_ = value.size() < Capacity ? value.size() : Capacity;
        for (std::size_t index = 0; index < size_; ++index) {
            data_[index] = value[index];
        }
        data_[size_] = '\0';
    }

    [[nodiscard]] constexpr bool append(char value) {
        if (size_ == Capacity) {
            return false;
        }
        data_[size_++] = value;
        data_[size_] = '\0';
        return true;
    }

    [[nodiscard]] constexpr bool append(std::string_view value) {
        if (size_ + value.size() > Capacity) {
            return false;
        }
        for (const char character : value) {
            data_[size_++] = character;
        }
        data_[size_] = '\0';
        return true;
    }

    constexpr void clear() {
        size_ = 0;
        data_[0] = '\0';
    }

    constexpr void pop_back() {
        if (size_ == 0) return;
        data_[--size_] = '\0';
    }

    [[nodiscard]] constexpr const char* c_str() const { return data_.data(); }
    [[nodiscard]] constexpr std::string_view view() const { return {data_.data(), size_}; }
    [[nodiscard]] constexpr std::size_t size() const { return size_; }
    [[nodiscard]] constexpr bool empty() const { return size_ == 0; }
    [[nodiscard]] static constexpr std::size_t capacity() { return Capacity; }

    [[nodiscard]] constexpr bool operator==(std::string_view other) const { return view() == other; }

private:
    std::array<char, Capacity + 1> data_{};
    std::size_t size_ = 0;
};

template <typename T, std::size_t Capacity>
class FixedVector {
public:
    [[nodiscard]] constexpr bool push_back(const T& value) {
        if (size_ == Capacity) {
            return false;
        }
        data_[size_++] = value;
        return true;
    }

    [[nodiscard]] constexpr bool push_back(T&& value) {
        if (size_ == Capacity) {
            return false;
        }
        data_[size_++] = std::move(value);
        return true;
    }

    template <typename... Args>
    [[nodiscard]] constexpr T* emplace_back(Args&&... args) {
        if (size_ == Capacity) {
            return nullptr;
        }
        data_[size_] = T(std::forward<Args>(args)...);
        return &data_[size_++];
    }

    constexpr void clear() { size_ = 0; }
    [[nodiscard]] constexpr std::size_t size() const { return size_; }
    [[nodiscard]] constexpr bool empty() const { return size_ == 0; }
    [[nodiscard]] static constexpr std::size_t capacity() { return Capacity; }

    [[nodiscard]] constexpr T& operator[](std::size_t index) { return data_[index]; }
    [[nodiscard]] constexpr const T& operator[](std::size_t index) const { return data_[index]; }
    [[nodiscard]] constexpr T* begin() { return data_.data(); }
    [[nodiscard]] constexpr T* end() { return data_.data() + size_; }
    [[nodiscard]] constexpr const T* begin() const { return data_.data(); }
    [[nodiscard]] constexpr const T* end() const { return data_.data() + size_; }

private:
    std::array<T, Capacity> data_{};
    std::size_t size_ = 0;
};

}  // namespace hosty
