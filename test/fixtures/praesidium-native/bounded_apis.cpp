// What the Praesidium baseline (src/praesidium/native/include/praesidium/baseline.h)
// leaves usable in C++: bounded formatting and copies through the std:: names, with the
// result checked. Revisor's own praesidium.json analyzes this unit.
#include <array>
#include <cstdio>
#include <cstring>
#include <string_view>

int format_id(std::array<char, 16>& out, int id) {
  const int written = std::snprintf(out.data(), out.size(), "id-%04d", id);
  if (written < 0 || static_cast<std::size_t>(written) >= out.size()) {
    out[0] = '\0';
    return -1;
  }
  return written;
}

bool copy_tag(std::array<char, 8>& out, std::string_view tag) {
  if (tag.size() >= out.size()) return false;
  std::memcpy(out.data(), tag.data(), tag.size());
  out[tag.size()] = '\0';
  return true;
}
