// PS5 direct connection, test 1: find the PS5 on the local network from the TV.
//
// Sends the PS5 Remote Play discovery request (the same one chiaki-ng uses) over UDP
// to port 9302, either to a given IP or as a broadcast, and reports every reply to JS
// as "VT_PS5: ..." messages. A reply proves that the TV app can reach the PS5 with
// plain UDP sockets, which the full Remote Play session will need.

#include "moonlight_wasm.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstring>
#include <string>
#include <thread>

namespace {

constexpr int kPs5DiscoveryPort = 9302;
constexpr const char* kPs5DiscoveryRequest =
  "SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n";

void Report(const std::string& text) {
  PostToJs("VT_PS5: " + text);
}

void DiscoverThread(std::string ip) {
  int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (sock < 0) {
    Report("HATA: UDP soketi açılamadı (errno " + std::to_string(errno) + ")");
    return;
  }

  int broadcast = 1;
  setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast));

  struct sockaddr_in local;
  memset(&local, 0, sizeof(local));
  local.sin_family = AF_INET;
  local.sin_port = htons(0);
  local.sin_addr.s_addr = htonl(INADDR_ANY);
  bind(sock, (struct sockaddr*)&local, sizeof(local));

  const bool useBroadcast = ip.empty();
  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_port = htons(kPs5DiscoveryPort);
  if (inet_pton(AF_INET, useBroadcast ? "255.255.255.255" : ip.c_str(), &dst.sin_addr) != 1) {
    Report("HATA: geçersiz IP adresi: " + ip);
    close(sock);
    return;
  }

  Report(std::string("aranıyor: ") + (useBroadcast ? "tüm ağ (yayın)" : ip) + " port 9302 ...");

  int replies = 0;
  for (int round = 0; round < 3 && replies == 0; round++) {
    // chiaki-ng sends the request including its terminating zero byte
    ssize_t sent = sendto(sock, kPs5DiscoveryRequest, strlen(kPs5DiscoveryRequest) + 1, 0,
                          (struct sockaddr*)&dst, sizeof(dst));
    if (sent < 0) {
      Report("HATA: gönderilemedi (errno " + std::to_string(errno) + ")");
      break;
    }

    // Collect replies for about 1.5 seconds
    for (int waited = 0; waited < 1500;) {
      struct pollfd pfd;
      pfd.fd = sock;
      pfd.events = POLLIN;
      pfd.revents = 0;
      int r = poll(&pfd, 1, 250);
      waited += 250;
      if (r <= 0 || !(pfd.revents & POLLIN)) continue;

      char buf[2048];
      struct sockaddr_in from;
      socklen_t fromLen = sizeof(from);
      ssize_t n = recvfrom(sock, buf, sizeof(buf) - 1, 0, (struct sockaddr*)&from, &fromLen);
      if (n <= 0) continue;
      buf[n] = '\0';
      char addr[INET_ADDRSTRLEN] = {0};
      inet_ntop(AF_INET, &from.sin_addr, addr, sizeof(addr));
      replies++;
      Report(std::string("CEVAP ") + addr + "\n" + buf);
    }
  }

  if (replies == 0) {
    Report("PS5 cevap vermedi. PS5 açık ya da dinlenme modunda mı, aynı ağda mı? IP'yi elle girip tekrar deneyin.");
  }
  close(sock);
}

}  // namespace

void ps5Discover(std::string ip) {
  std::thread(DiscoverThread, ip).detach();
}
