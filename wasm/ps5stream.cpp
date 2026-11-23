// Direct PS5 Remote Play inside the Moonlight TV app (no PC in between).
//
// The PS5 stream is plugged into Moonlight's existing pipeline: chiaki-ng runs the
// Remote Play session, its video frames go to Moonlight's video decoder callbacks
// (EMSS player, also read by the translation overlay), its Opus audio goes to
// Moonlight's audio decoder, and the gamepads polled by Moonlight are sent to the
// PS5 as DualSense input. A stream is started by passing a host string of the form
//   PS5:<ip>|<regist key hex>|<rp key hex>|<psn account id base64>
// to the normal startStream call.

#include "moonlight_wasm.hpp"

#include <chiaki/base64.h>
#include <chiaki/controller.h>
#include <chiaki/discovery.h>
#include <chiaki/log.h>
#include <chiaki/session.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

#include <emscripten.h>
#include <emscripten/threading.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

ChiakiLog s_log;
ChiakiSession s_session;
std::atomic<bool> s_sessionActive{false};  // chiaki session initialized and not yet finished
std::atomic<bool> s_ps5Mode{false};        // the current Moonlight stream is a PS5 stream
std::atomic<bool> s_stopRequested{false};
std::atomic<bool> s_connected{false};
std::string s_ip;
std::mutex s_sessionMutex;

std::mutex s_padMutex;
ChiakiControllerState s_pads[4];
bool s_padUsed[4];

int s_frameNumber = 0;
std::vector<uint8_t> s_frameCopy;

// --- messages to JS, never blocking the calling (network) thread ---

void DeliverToJs(char* text) {
  EM_ASM({ handleMessage(UTF8ToString($0)); }, text);
  free(text);
}

void PostAsync(const std::string& msg) {
  char* copy = strdup(msg.c_str());
  if (copy) emscripten_async_run_in_main_runtime_thread(EM_FUNC_SIG_VI, (void*)DeliverToJs, copy);
}

// Short status lines for the user (shown as a notification during the stream)
void Notice(const std::string& text) {
  PostAsync("VT_PS5_NOTICE: " + text);
}

void LogCb(ChiakiLogLevel level, const char* msg, void* user) {
  (void)user;
  if (!(level & (CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO))) return;
  static const char* noisy[] = {"re-sending packet", "CTRL RECEIVED", "offset 0", "Heartbeat",
                                "dropping data", "Takion Send Buffer", nullptr};
  for (int i = 0; noisy[i]; i++)
    if (strstr(msg, noisy[i])) return;
  if (msg[0] == ' ' || (msg[0] >= '0' && msg[0] <= '9')) return;
  // Moonlight's own log goes to the console without blocking
  emscripten_log(EM_LOG_CONSOLE, "chiaki: %s", msg);
}

void StartedOnMain(int unused) {
  (void)unused;
  if (g_Instance) g_Instance->OnConnectionStarted(0);
}

void StoppedOnMain(int code) {
  if (g_Instance) g_Instance->OnConnectionStopped((uint32_t)code);
}

bool Cancelled() {
  return s_stopRequested || (g_Instance && g_Instance->ConnectionCancelled());
}

bool FromHex(const std::string& hex, uint8_t* out, size_t size) {
  if (hex.size() != size * 2) return false;
  for (size_t i = 0; i < size; i++) {
    unsigned v;
    if (sscanf(hex.c_str() + i * 2, "%2x", &v) != 1) return false;
    out[i] = (uint8_t)v;
  }
  return true;
}

// --- PS5 state check and wake-up ---

struct HostCheck {
  std::atomic<int> state{-1};
};

void HostCheckCb(ChiakiDiscoveryHost* host, void* user) {
  static_cast<HostCheck*>(user)->state = (int)host->state;
}

// 1 ready, 2 rest mode, -1 no answer
int QueryState(const std::string& ip) {
  ChiakiDiscovery discovery;
  if (chiaki_discovery_init(&discovery, &s_log, AF_INET) != CHIAKI_ERR_SUCCESS) return -1;
  HostCheck check;
  ChiakiDiscoveryThread thread;
  if (chiaki_discovery_thread_start(&thread, &discovery, HostCheckCb, &check) != CHIAKI_ERR_SUCCESS) {
    chiaki_discovery_fini(&discovery);
    return -1;
  }
  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_port = htons(CHIAKI_DISCOVERY_PORT_PS5);
  inet_pton(AF_INET, ip.c_str(), &dst.sin_addr);
  ChiakiDiscoveryPacket packet;
  memset(&packet, 0, sizeof(packet));
  packet.cmd = CHIAKI_DISCOVERY_CMD_SRCH;
  packet.protocol_version = (char*)CHIAKI_DISCOVERY_PROTOCOL_VERSION_PS5;
  for (int i = 0; i < 4 && check.state < 0; i++) {
    chiaki_discovery_send(&discovery, &packet, (struct sockaddr*)&dst, sizeof(dst));
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  chiaki_discovery_thread_stop(&thread);
  chiaki_discovery_fini(&discovery);
  int s = check.state;
  return s == CHIAKI_DISCOVERY_HOST_STATE_READY ? 1 : s == CHIAKI_DISCOVERY_HOST_STATE_STANDBY ? 2 : -1;
}

// --- chiaki callbacks ---

// H.264 keyframe: an IDR picture or an SPS in the frame
bool IsH264Keyframe(const uint8_t* buf, size_t size) {
  for (size_t i = 0; i + 4 < size; i++) {
    if (buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1) {
      uint8_t type = buf[i + 3] & 0x1f;
      if (type == 5 || type == 7) return true;
      i += 2;
    }
  }
  return false;
}

bool VideoCb(uint8_t* buf, size_t size, int32_t framesLost, bool recovered, void* user) {
  (void)framesLost;
  (void)recovered;
  (void)user;
  if (s_stopRequested) return true;

  LENTRY entry;
  entry.next = nullptr;
  entry.data = reinterpret_cast<char*>(buf);
  entry.length = (int)size;
  entry.bufferType = BUFFER_TYPE_PICDATA;

  DECODE_UNIT unit;
  memset(&unit, 0, sizeof(unit));
  unit.frameNumber = ++s_frameNumber;
  unit.frameType = IsH264Keyframe(buf, size) ? FRAME_TYPE_IDR : FRAME_TYPE_PFRAME;
  unit.receiveTimeMs = LiGetMillis();
  unit.enqueueTimeMs = unit.receiveTimeMs;
  unit.presentationTimeMs = (unsigned int)unit.receiveTimeMs;
  unit.fullLength = (int)size;
  unit.bufferList = &entry;

  int r = MoonlightInstance::s_DrCallbacks.submitDecodeUnit(&unit);
  // false asks chiaki to request a new keyframe from the PS5
  return r == DR_OK;
}

void AudioHeaderCb(ChiakiAudioHeader* header, void* user) {
  (void)user;
  emscripten_log(EM_LOG_CONSOLE, "PS5 audio: %u channels, %u Hz, %u samples per frame",
                 (unsigned)header->channels, (unsigned)header->rate, (unsigned)header->frame_size);
}

void AudioFrameCb(uint8_t* buf, size_t size, void* user) {
  (void)user;
  if (s_stopRequested) return;
  MoonlightInstance::s_ArCallbacks.decodeAndPlaySample(reinterpret_cast<char*>(buf), (int)size);
}

void EventCb(ChiakiEvent* event, void* user) {
  (void)user;
  switch (event->type) {
    case CHIAKI_EVENT_CONNECTED:
      s_connected = true;
      emscripten_async_run_in_main_runtime_thread(EM_FUNC_SIG_VI, (void*)StartedOnMain, 0);
      break;
    case CHIAKI_EVENT_LOGIN_PIN_REQUEST:
      Notice("PS5 giriş şifresi istiyor. PS5'te kullanıcınızla giriş yapıp ana ekranda bırakın.");
      break;
    case CHIAKI_EVENT_RUMBLE:
      if (g_Instance) MoonlightInstance::ClControllerRumble(0, (unsigned short)(event->rumble.left * 257),
                                                            (unsigned short)(event->rumble.right * 257));
      break;
    case CHIAKI_EVENT_QUIT: {
      bool expected = s_stopRequested;
      if (!expected) {
        std::string reason = chiaki_quit_reason_string(event->quit.reason);
        if (event->quit.reason_str) reason += std::string(" — ") + event->quit.reason_str;
        Notice(std::string("PS5 bağlantısı kapandı: ") + reason +
               (s_connected ? "" : ". PS5 açık ve kullanıcı giriş yapmış halde ana ekranda olmalı."));
        // Tear down like any ended Moonlight stream (the stop thread calls Ps5Stop)
        g_Instance->CancelPendingSetup();
        emscripten_async_run_in_main_runtime_thread(EM_FUNC_SIG_VI, (void*)StoppedOnMain, 0);  // reason shown above
      }
      break;
    }
    default:
      break;
  }
}

}  // namespace

bool Ps5IsHost(const std::string& host) {
  return host.rfind("PS5:", 0) == 0;
}

bool Ps5Mode() {
  return s_ps5Mode;
}

// Runs on Moonlight's connection thread in place of LiStartConnection.
// Returns 0 once the session has been started, or a negative error.
int Ps5ConnectionRun(const std::string& host, int width, int height, int fps) {
  s_ps5Mode = true;
  s_stopRequested = false;
  s_connected = false;
  s_frameNumber = 0;
  {
    std::lock_guard<std::mutex> lock(s_padMutex);
    for (int i = 0; i < 4; i++) {
      chiaki_controller_state_set_idle(&s_pads[i]);
      s_padUsed[i] = false;
    }
  }

  chiaki_log_init(&s_log, CHIAKI_LOG_ERROR | CHIAKI_LOG_WARNING | CHIAKI_LOG_INFO, LogCb, nullptr);
  chiaki_lib_init();

  // Parse "PS5:ip|regist|rpkey|account"
  std::vector<std::string> parts;
  {
    std::string rest = host.substr(4);
    size_t start = 0;
    for (;;) {
      size_t bar = rest.find('|', start);
      parts.push_back(rest.substr(start, bar == std::string::npos ? std::string::npos : bar - start));
      if (bar == std::string::npos) break;
      start = bar + 1;
    }
  }
  if (parts.size() < 4) {
    Notice("PS5 eşleştirme bilgisi eksik. Ayarlardan (YEŞİL tuş) yeniden eşleştirin.");
    return -1;
  }
  s_ip = parts[0];

  ChiakiConnectInfo info;
  memset(&info, 0, sizeof(info));
  if (!FromHex(parts[1], (uint8_t*)info.regist_key, sizeof(info.regist_key)) ||
      !FromHex(parts[2], info.morning, sizeof(info.morning))) {
    Notice("PS5 eşleştirme anahtarları okunamadı. Yeniden eşleştirin.");
    return -1;
  }
  size_t idSize = sizeof(info.psn_account_id);
  chiaki_base64_decode(parts[3].c_str(), parts[3].size(), info.psn_account_id, &idSize);

  // Wake the PS5 if it is in rest mode
  PostToJs("ProgressMsg: PS5'e bağlanılıyor (" + s_ip + ")...");
  int state = QueryState(s_ip);
  if (state == 2) {
    char keyStr[CHIAKI_SESSION_AUTH_SIZE + 1];
    memcpy(keyStr, info.regist_key, CHIAKI_SESSION_AUTH_SIZE);
    keyStr[CHIAKI_SESSION_AUTH_SIZE] = '\0';
    uint64_t credential = strtoull(keyStr, nullptr, 16);
    PostToJs("ProgressMsg: PS5 dinlenme modunda, uyandırılıyor...");
    chiaki_discovery_wakeup(&s_log, nullptr, s_ip.c_str(), credential, true);
    for (int i = 0; i < 25 && state != 1 && !Cancelled(); i++) {
      std::this_thread::sleep_for(std::chrono::seconds(2));
      state = QueryState(s_ip);
    }
    if (state == 1) {
      // Give the PS5 a moment to finish starting up and sign in the user
      PostToJs("ProgressMsg: PS5 uyandı, oturum açılıyor...");
      for (int i = 0; i < 80 && !Cancelled(); i++) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  }
  if (Cancelled()) return -1;
  if (state != 1) {
    Notice("PS5 cevap vermedi (" + s_ip + "). PS5 açık mı, aynı ağda mı?");
    return -1;
  }

  // Always 1080p at 60 frames per second. H.264: the PS5's HEVC stream left this TV's
  // player on a black screen.
  (void)width; (void)height; (void)fps;
  chiaki_connect_video_profile_preset(&info.video_profile, CHIAKI_VIDEO_RESOLUTION_PRESET_1080p, CHIAKI_VIDEO_FPS_PRESET_60);
  info.video_profile.codec = CHIAKI_CODEC_H264;
  int streamWidth = (int)info.video_profile.width;
  int streamHeight = (int)info.video_profile.height;
  int streamFps = (int)info.video_profile.max_fps;

  info.ps5 = true;
  info.host = s_ip.c_str();
  info.video_profile_auto_downgrade = false;
  info.enable_keyboard = false;
  info.enable_dualsense = true;
  info.audio_video_disabled = CHIAKI_NONE_DISABLED;
  info.auto_regist = false;
  info.holepunch_session = nullptr;
  info.rudp_sock = nullptr;
  info.packet_loss_max = 0.05;
  info.enable_idr_on_fec_failure = true;

  // Audio: PS5 sends stereo Opus at 48 kHz, 10 ms frames
  OPUS_MULTISTREAM_CONFIGURATION opus;
  memset(&opus, 0, sizeof(opus));
  opus.sampleRate = 48000;
  opus.channelCount = 2;
  opus.streams = 1;
  opus.coupledStreams = 1;
  opus.samplesPerFrame = 480;
  opus.mapping[0] = 0;
  opus.mapping[1] = 1;
  if (MoonlightInstance::s_ArCallbacks.init(AUDIO_CONFIGURATION_STEREO, &opus, nullptr, 0) != 0)
    emscripten_log(EM_LOG_CONSOLE, "PS5: audio init failed, continuing without sound");

  // Video player (same media pipeline as a PC stream)
  PostToJs("ProgressMsg: Görüntü hazırlanıyor...");
  int r = MoonlightInstance::s_DrCallbacks.setup(VIDEO_FORMAT_H264, streamWidth, streamHeight, streamFps, nullptr, 0);
  if (r != 0) {
    MoonlightInstance::s_ArCallbacks.cleanup();
    return r;
  }
  if (Cancelled()) return -1;

  std::lock_guard<std::mutex> lock(s_sessionMutex);
  ChiakiErrorCode err = chiaki_session_init(&s_session, &info, &s_log);
  if (err != CHIAKI_ERR_SUCCESS) {
    Notice(std::string("PS5 oturumu hazırlanamadı: ") + chiaki_error_string(err));
    return -1;
  }
  chiaki_session_set_event_cb(&s_session, EventCb, nullptr);
  chiaki_session_set_video_sample_cb(&s_session, VideoCb, nullptr);
  static ChiakiAudioSink sink;
  sink.user = nullptr;
  sink.header_cb = AudioHeaderCb;
  sink.frame_cb = AudioFrameCb;
  chiaki_session_set_audio_sink(&s_session, &sink);

  PostToJs("ProgressMsg: PS5 oturumu açılıyor...");
  err = chiaki_session_start(&s_session);
  if (err != CHIAKI_ERR_SUCCESS) {
    chiaki_session_fini(&s_session);
    Notice(std::string("PS5 oturumu başlatılamadı: ") + chiaki_error_string(err));
    return -1;
  }
  s_sessionActive = true;
  return 0;
}

// Called by Moonlight's stop thread in place of LiStopConnection
void Ps5Stop() {
  s_stopRequested = true;
  std::lock_guard<std::mutex> lock(s_sessionMutex);
  if (s_sessionActive) {
    chiaki_session_stop(&s_session);
    chiaki_session_join(&s_session);
    chiaki_session_fini(&s_session);
    s_sessionActive = false;
    MoonlightInstance::s_ArCallbacks.cleanup();
    MoonlightInstance::s_DrCallbacks.cleanup();
  }
  s_ps5Mode = false;
}

// Gamepad input from Moonlight's poller, in Moonlight's format
void Ps5SendController(int index, int buttonFlags, unsigned char leftTrigger, unsigned char rightTrigger,
                       short leftStickX, short leftStickY, short rightStickX, short rightStickY) {
  if (!s_sessionActive || index < 0 || index > 3) return;
  uint32_t b = 0;
  if (buttonFlags & A_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_CROSS;
  if (buttonFlags & B_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_MOON;
  if (buttonFlags & X_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_BOX;
  if (buttonFlags & Y_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_PYRAMID;
  if (buttonFlags & UP_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_DPAD_UP;
  if (buttonFlags & DOWN_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_DPAD_DOWN;
  if (buttonFlags & LEFT_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_DPAD_LEFT;
  if (buttonFlags & RIGHT_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_DPAD_RIGHT;
  if (buttonFlags & LB_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_L1;
  if (buttonFlags & RB_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_R1;
  if (buttonFlags & LS_CLK_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_L3;
  if (buttonFlags & RS_CLK_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_R3;
  if (buttonFlags & PLAY_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_OPTIONS;
  if (buttonFlags & BACK_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_SHARE;
  if (buttonFlags & SPECIAL_FLAG) b |= CHIAKI_CONTROLLER_BUTTON_PS;
  if (buttonFlags & (TOUCHPAD_FLAG | MISC_FLAG)) b |= CHIAKI_CONTROLLER_BUTTON_TOUCHPAD;

  // Moonlight's stick Y axis points up, chiaki's points down
  auto flip = [](short v) -> int16_t { return v == -32768 ? 32767 : (int16_t)(-v); };

  ChiakiControllerState sum;
  {
    std::lock_guard<std::mutex> lock(s_padMutex);
    ChiakiControllerState& s = s_pads[index];
    s.buttons = b;
    s.l2_state = leftTrigger;
    s.r2_state = rightTrigger;
    s.left_x = leftStickX;
    s.left_y = flip(leftStickY);
    s.right_x = rightStickX;
    s.right_y = flip(rightStickY);
    s_padUsed[index] = true;
    chiaki_controller_state_set_idle(&sum);
    for (int i = 0; i < 4; i++)
      if (s_padUsed[i]) chiaki_controller_state_or(&sum, &sum, &s_pads[i]);
  }
  chiaki_session_set_controller_state(&s_session, &sum);
}
