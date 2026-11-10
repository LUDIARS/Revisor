/* What the Praesidium baseline (src/praesidium/native/include/praesidium/baseline.h)
 * leaves usable in C: bounded formatting and copies, with the result checked. Revisor's
 * own praesidium.json analyzes this unit, and a change to the baseline header is compiled
 * with its configuration (the header's C job; bounded_apis.cpp gives the C++ one). */
#include <stdio.h>
#include <string.h>

int format_id(char* out, size_t size, int id) {
  int written = snprintf(out, size, "id-%04d", id);
  if (written < 0 || (size_t)written >= size) {
    if (size > 0) out[0] = '\0';
    return -1;
  }
  return written;
}

int copy_tag(char out[8], const char* tag) {
  size_t length = strlen(tag);
  if (length >= 8) return -1;
  memcpy(out, tag, length + 1);
  return 0;
}
