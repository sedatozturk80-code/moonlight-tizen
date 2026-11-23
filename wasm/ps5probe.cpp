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

// PS5 direct connection, test 2: the chiaki-ng core running inside the TV app.
// Checks that the library starts, that its PS5 key exchange crypto works with the
// TV's OpenSSL, and that chiaki's own discovery (its threads, stop handling and
// sockets on Tizen) finds the PS5.

#include <chiaki/common.h>
#include <chiaki/discovery.h>
#include <chiaki/ecdh.h>
#include <chiaki/log.h>

#include <chrono>

namespace {

void ChiakiLogToJs(ChiakiLogLevel level, const char* msg, void* user) {
  (void)user;
  if (level & (CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO))
    Report(std::string("chiaki: ") + msg);
}

void ChiakiFoundHost(ChiakiDiscoveryHost* host, void* user) {
  int* found = static_cast<int*>(user);
  (*found)++;
  std::string text = "chiaki PS5'i buldu: ";
  text += host->host_name ? host->host_name : "?";
  text += " (";
  text += host->host_addr ? host->host_addr : "?";
  text += ") durum: ";
  text += chiaki_discovery_host_state_string(host->state);
  text += ", sistem ";
  text += host->system_version ? host->system_version : "?";
  Report(text);
}

void ChiakiTestThread(std::string ip) {
  static ChiakiLog log;
  chiaki_log_init(&log, CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO, ChiakiLogToJs, nullptr);

  Report("TEST 2 başladı: chiaki-ng çekirdeği");
  ChiakiErrorCode err = chiaki_lib_init();
  Report(std::string("1) kütüphane: ") + chiaki_error_string(err));
  if (err != CHIAKI_ERR_SUCCESS) return;

  ChiakiECDH ecdh;
  err = chiaki_ecdh_init(&ecdh);
  if (err == CHIAKI_ERR_SUCCESS) {
    uint8_t handshake[16] = {0};
    uint8_t pub[128];
    size_t pubSize = sizeof(pub);
    uint8_t sig[64];
    size_t sigSize = sizeof(sig);
    err = chiaki_ecdh_get_local_pub_key(&ecdh, pub, &pubSize, handshake, sig, &sigSize);
    Report(std::string("2) şifreleme (anahtar değişimi): ") + chiaki_error_string(err) +
           " — açık anahtar " + std::to_string(pubSize) + " bayt");
    chiaki_ecdh_fini(&ecdh);
  } else {
    Report(std::string("2) şifreleme başlatılamadı: ") + chiaki_error_string(err));
  }

  ChiakiDiscovery discovery;
  err = chiaki_discovery_init(&discovery, &log, AF_INET);
  if (err != CHIAKI_ERR_SUCCESS) {
    Report(std::string("3) keşif başlatılamadı: ") + chiaki_error_string(err));
    return;
  }
  int found = 0;
  ChiakiDiscoveryThread thread;
  err = chiaki_discovery_thread_start(&thread, &discovery, ChiakiFoundHost, &found);
  if (err != CHIAKI_ERR_SUCCESS) {
    Report(std::string("3) keşif iş parçacığı açılamadı: ") + chiaki_error_string(err));
    chiaki_discovery_fini(&discovery);
    return;
  }

  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_port = htons(CHIAKI_DISCOVERY_PORT_PS5);
  inet_pton(AF_INET, ip.empty() ? "255.255.255.255" : ip.c_str(), &dst.sin_addr);
  ChiakiDiscoveryPacket packet;
  memset(&packet, 0, sizeof(packet));
  packet.cmd = CHIAKI_DISCOVERY_CMD_SRCH;
  packet.protocol_version = (char*)CHIAKI_DISCOVERY_PROTOCOL_VERSION_PS5;
  for (int i = 0; i < 3 && found == 0; i++) {
    err = chiaki_discovery_send(&discovery, &packet, (struct sockaddr*)&dst, sizeof(dst));
    if (err != CHIAKI_ERR_SUCCESS) Report(std::string("3) keşif gönderilemedi: ") + chiaki_error_string(err));
    std::this_thread::sleep_for(std::chrono::milliseconds(1500));
  }

  auto t0 = std::chrono::steady_clock::now();
  chiaki_discovery_thread_stop(&thread);
  auto stopMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
  chiaki_discovery_fini(&discovery);
  Report(std::string("3) keşif: ") + (found ? "başarılı" : "PS5 cevap vermedi") +
         ", durdurma " + std::to_string(stopMs) + " ms");
  Report("TEST 2 bitti.");
}

}  // namespace

void ps5ChiakiTest(std::string ip) {
  std::thread(ChiakiTestThread, ip).detach();
}

// PS5 direct connection, test 3a: pair (register) the TV with the PS5.
// Uses the PSN account ID (base64, 8 bytes) and the 8-digit PIN shown on the PS5
// under Settings > System > Remote Play > Link Device. On success the keys needed
// for later sessions are sent to JS as "KAYIT_OK {json}" and stored only on the TV.

#include <chiaki/base64.h>
#include <chiaki/regist.h>

#include <atomic>

namespace {

std::string Hex(const uint8_t* data, size_t size) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  for (size_t i = 0; i < size; i++) {
    out += digits[data[i] >> 4];
    out += digits[data[i] & 0xf];
  }
  return out;
}

std::string JsonString(const char* text, size_t maxLen) {
  std::string out = "\"";
  for (size_t i = 0; i < maxLen && text[i]; i++) {
    unsigned char c = text[i];
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (c < 0x20) out += ' ';
    else out += c;
  }
  return out + "\"";
}

struct RegistState {
  std::atomic<int> done{0};
  std::string ip;
};

void RegistCallback(ChiakiRegistEvent* event, void* user) {
  RegistState* state = static_cast<RegistState*>(user);
  if (event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS && event->registered_host) {
    ChiakiRegisteredHost* h = event->registered_host;
    std::string json = "{";
    json += "\"ip\":\"" + state->ip + "\"";
    json += ",\"target\":" + std::to_string((int)h->target);
    json += ",\"nickname\":" + JsonString(h->server_nickname, sizeof(h->server_nickname));
    json += ",\"mac\":\"" + Hex(h->server_mac, sizeof(h->server_mac)) + "\"";
    json += ",\"regist_key\":\"" + Hex((const uint8_t*)h->rp_regist_key, sizeof(h->rp_regist_key)) + "\"";
    json += ",\"key_type\":" + std::to_string(h->rp_key_type);
    json += ",\"rp_key\":\"" + Hex(h->rp_key, sizeof(h->rp_key)) + "\"";
    json += ",\"console_pin\":" + std::to_string(h->console_pin);
    json += "}";
    Report("KAYIT_OK " + json);
  } else if (event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_CANCELED) {
    Report("Eşleştirme iptal edildi.");
  } else {
    Report("Eşleştirme BAŞARISIZ. PIN'in süresi dolmuş olabilir ya da hesap kimliği yanlış olabilir. "
           "PS5'te yeni PIN alıp tekrar deneyin.");
  }
  state->done = 1;
}

void RegistThread(std::string ip, std::string accountB64, uint32_t pin) {
  static ChiakiLog log;
  chiaki_log_init(&log, CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO, ChiakiLogToJs, nullptr);
  chiaki_lib_init();

  ChiakiRegistInfo info;
  memset(&info, 0, sizeof(info));
  size_t idSize = sizeof(info.psn_account_id);
  if (chiaki_base64_decode(accountB64.c_str(), accountB64.size(), info.psn_account_id, &idSize) != CHIAKI_ERR_SUCCESS ||
      idSize != CHIAKI_PSN_ACCOUNT_ID_SIZE) {
    Report("PSN hesap kimliği çözülemedi (12 karakter olmalı, = ile biter). Tekrar yazın.");
    return;
  }
  const bool broadcast = ip.empty();
  info.target = CHIAKI_TARGET_PS5_1;
  info.host = broadcast ? "255.255.255.255" : ip.c_str();
  info.broadcast = broadcast;
  info.psn_online_id = nullptr;
  info.pin = pin;
  info.console_pin = 0;
  info.holepunch_info = nullptr;
  info.rudp = nullptr;

  RegistState state;
  state.ip = ip;
  ChiakiRegist regist;
  Report(std::string("Eşleştiriliyor: ") + info.host + " ...");
  ChiakiErrorCode err = chiaki_regist_start(&regist, &log, &info, RegistCallback, &state);
  if (err != CHIAKI_ERR_SUCCESS) {
    Report(std::string("Eşleştirme başlatılamadı: ") + chiaki_error_string(err));
    return;
  }
  for (int i = 0; i < 600 && !state.done; i++)  // up to 60 s
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  if (!state.done) {
    Report("Eşleştirme 60 saniyede bitmedi, durduruluyor.");
    chiaki_regist_stop(&regist);
  }
  chiaki_regist_fini(&regist);
}

}  // namespace

void ps5Regist(std::string ip, std::string accountB64, int pin) {
  std::thread(RegistThread, ip, accountB64, (uint32_t)pin).detach();
}
