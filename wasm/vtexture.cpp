// Video texture + live Turkish subtitles (PS5 Türkçe çeviri projesi, adım 3)
//
// The WASM Player decodes each video frame into a GL texture owned by this app instead of
// drawing it on the <video> element. We draw that texture on a full-screen <canvas>, and
// every second we read the subtitle area of the drawn frame back with glReadPixels. If the read works, the
// app can see the game picture. The bottom of the picture is handed to vt_translate.js,
// which sends new subtitles to Gemini and shows the Turkish translation (#vt_sub).

#include "moonlight_wasm.hpp"

#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/threading.h>

#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <vector>

#include "samsung/wasm/operation_result.h"

#ifndef GL_TEXTURE_EXTERNAL_OES
#define GL_TEXTURE_EXTERNAL_OES 0x8D65
#endif

namespace {

constexpr int kCanvasWidth = 1920;
constexpr int kCanvasHeight = 1080;
constexpr double kReadIntervalMs = 1000.0;
// Bottom part of the picture that is sent to the translator (subtitles live here)
constexpr int kRegionHeight = kCanvasHeight * 30 / 100;

const char* kVertexShader =
  "attribute vec2 a_position;\n"
  "attribute vec2 a_texCoord;\n"
  "varying vec2 v_texCoord;\n"
  "void main() {\n"
  "  gl_Position = vec4(a_position, 0.0, 1.0);\n"
  "  v_texCoord = a_texCoord;\n"
  "}\n";

const char* kFragmentShader =
  "#extension GL_OES_EGL_image_external : require\n"
  "precision mediump float;\n"
  "uniform samplerExternalOES s_texture;\n"
  "varying vec2 v_texCoord;\n"
  "void main() {\n"
  "  gl_FragColor = texture2D(s_texture, v_texCoord);\n"
  "}\n";

EMSCRIPTEN_WEBGL_CONTEXT_HANDLE s_context = 0;
GLuint s_program = 0;
GLuint s_texture = 0;
GLuint s_vbo = 0;
std::atomic<bool> s_running{false};
long s_animationFrameId = 0;
double s_lastReadMs = 0.0;
std::atomic<uint32_t> s_drawnFrames{0};
std::atomic<uint32_t> s_fillErrors{0};
std::atomic<int> s_lastFillError{0};
std::atomic<uint32_t> s_readOk{0};
std::atomic<uint32_t> s_readErrors{0};
std::atomic<uint32_t> s_drawErrors{0};
std::atomic<int> s_lastGlError{0};
uint32_t s_readCount = 0;
std::vector<uint8_t> s_pixels;

// All functions in this file run on the main browser thread
void SetInfo(const char* text) {
  EM_ASM({
    var box = document.getElementById('vt_info');
    if (box) {
      box.style.display = 'block';
      box.textContent = UTF8ToString($0);
    }
  }, text);
}

void ShowCanvas(bool show) {
  EM_ASM({
    var canvas = document.getElementById('vt_canvas');
    if (canvas) canvas.style.display = $0 ? 'block' : 'none';
  }, show ? 1 : 0);
}

GLuint CompileShader(GLenum type, const char* source) {
  GLuint shader = glCreateShader(type);
  glShaderSource(shader, 1, &source, nullptr);
  glCompileShader(shader);
  GLint ok = 0;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[512] = {0};
    glGetShaderInfoLog(shader, sizeof(log) - 1, nullptr, log);
    MoonlightInstance::ClLogMessage("VT: shader compile failed: %s\n", log);
  }
  return shader;
}

bool InitGl() {
  if (s_context) {
    emscripten_webgl_make_context_current(s_context);
    return true;
  }

  emscripten_set_canvas_element_size("#vt_canvas", kCanvasWidth, kCanvasHeight);

  EmscriptenWebGLContextAttributes attrs;
  emscripten_webgl_init_context_attributes(&attrs);
  attrs.alpha = false;
  attrs.depth = false;
  attrs.stencil = false;
  attrs.antialias = false;
  attrs.preserveDrawingBuffer = false;
  attrs.majorVersion = 1;
  attrs.minorVersion = 0;

  s_context = emscripten_webgl_create_context("#vt_canvas", &attrs);
  if (s_context <= 0) {
    MoonlightInstance::ClLogMessage("VT: emscripten_webgl_create_context failed: %d\n", (int)s_context);
    SetInfo("VT HATA: WebGL baglami olusturulamadi");
    s_context = 0;
    return false;
  }
  emscripten_webgl_make_context_current(s_context);
  emscripten_webgl_enable_extension(s_context, "OES_EGL_image_external");

  s_program = glCreateProgram();
  glAttachShader(s_program, CompileShader(GL_VERTEX_SHADER, kVertexShader));
  glAttachShader(s_program, CompileShader(GL_FRAGMENT_SHADER, kFragmentShader));
  glBindAttribLocation(s_program, 0, "a_position");
  glBindAttribLocation(s_program, 1, "a_texCoord");
  glLinkProgram(s_program);
  GLint linked = 0;
  glGetProgramiv(s_program, GL_LINK_STATUS, &linked);
  if (!linked) {
    MoonlightInstance::ClLogMessage("VT: program link failed\n");
    SetInfo("VT HATA: shader programi baglanamadi");
    return false;
  }
  glUseProgram(s_program);
  glUniform1i(glGetUniformLocation(s_program, "s_texture"), 0);

  // x, y, u, v for a full-screen triangle strip
  const GLfloat quad[] = {
    -1.f, -1.f, 0.f, 1.f,
     1.f, -1.f, 1.f, 1.f,
    -1.f,  1.f, 0.f, 0.f,
     1.f,  1.f, 1.f, 0.f,
  };
  glGenBuffers(1, &s_vbo);
  glBindBuffer(GL_ARRAY_BUFFER, s_vbo);
  glBufferData(GL_ARRAY_BUFFER, sizeof(quad), quad, GL_STATIC_DRAW);
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void*)0);
  glEnableVertexAttribArray(1);
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(GLfloat), (void*)(2 * sizeof(GLfloat)));

  glGenTextures(1, &s_texture);
  glViewport(0, 0, kCanvasWidth, kCanvasHeight);
  s_pixels.resize((size_t)kCanvasWidth * kRegionHeight * 4);
  return true;
}

void RequestFrame();

// Reads the subtitle region of the frame that was just drawn and hands it to vt_translate.js
void ReadBack() {
  // Reading keeps failing on this TV: stop trying, so the main thread only draws the picture
  if (s_readErrors >= 5 && s_readOk == 0) return;
  // glGetError reports the oldest error since the last call, which may belong to an earlier
  // GL call (texture binding, drawing), so clear those first to see the read's own result
  for (int i = 0; i < 8 && glGetError() != GL_NO_ERROR; i++) {}
  // GL's origin is the bottom-left corner, so rows 0..kRegionHeight are the bottom of the picture
  glReadPixels(0, 0, kCanvasWidth, kRegionHeight, GL_RGBA, GL_UNSIGNED_BYTE, s_pixels.data());
  GLenum err = glGetError();
  s_readCount++;
  if (err != GL_NO_ERROR) {
    // Keep drawing the picture; the error is shown in the PS5 status line
    s_readErrors++;
    s_lastGlError = (int)err;
    if (s_readErrors == 1) {
      char text[96];
      snprintf(text, sizeof(text), "VT HATA: kare okunamadi (GL 0x%x), goruntu cizilmeye devam ediyor", (unsigned)err);
      SetInfo(text);
    }
    return;
  }
  if (s_readOk++ == 0) {
    // The status line goes back to the translator once a frame could be read
    EM_ASM({ window.vtFirstReadOk = true; });
  }
  EM_ASM({
    if (window.vtOnSubtitleFrame) {
      var copy = HEAPU8.slice($0, $0 + $1 * $2 * 4);
      window.vtOnSubtitleFrame(copy, $1, $2);
    }
  }, s_pixels.data(), kCanvasWidth, kRegionHeight);
}

EM_BOOL OnAnimationFrame(double now, void*) {
  s_animationFrameId = 0;
  if (!s_running) return EM_FALSE;
  g_Instance->VideoTrack().RecycleTexture(s_texture);
  RequestFrame();
  return EM_FALSE;
}

void Draw() {
  emscripten_webgl_make_context_current(s_context);
  glClear(GL_COLOR_BUFFER_BIT);
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_EXTERNAL_OES, s_texture);
  glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
  GLenum drawErr = glGetError();
  if (drawErr != GL_NO_ERROR) {
    s_drawErrors++;
    s_lastGlError = (int)drawErr;
  }
  s_drawnFrames++;
  if (s_drawnFrames == 1) {
    // The PS5 diagnostics stop replacing the status line once the picture is on screen
    EM_ASM({ window.vtFirstFrameSeen = true; });
  }

  double now = emscripten_get_now();
  if (now - s_lastReadMs >= kReadIntervalMs) {
    s_lastReadMs = now;
    ReadBack();
  }
  s_animationFrameId = emscripten_request_animation_frame(OnAnimationFrame, nullptr);
}

void RequestFrame() {
  if (!s_running) return;
  auto result = g_Instance->VideoTrack().FillTextureWithNextFrame(
    s_texture, [](samsung::wasm::OperationResult r) {
      if (r == samsung::wasm::OperationResult::kSuccess) {
        Draw();
      } else if (r == samsung::wasm::OperationResult::kAborted ||
                 r == samsung::wasm::OperationResult::kAlreadyDestroyed) {
        MoonlightInstance::ClLogMessage("VT: track stopped (%d)\n", (int)r);
        s_running = false;
      } else {
        MoonlightInstance::ClLogMessage("VT: FillTextureWithNextFrame failed (%d), retrying\n", (int)r);
        s_fillErrors++;
        s_lastFillError = (int)r;
        s_animationFrameId = emscripten_request_animation_frame(
          [](double, void*) -> EM_BOOL { s_animationFrameId = 0; RequestFrame(); return EM_FALSE; }, nullptr);
      }
    });
  if (!result) {
    MoonlightInstance::ClLogMessage("VT: FillTextureWithNextFrame call rejected\n");
    SetInfo("VT HATA: TV kareyi dokuya vermeyi reddetti (FillTextureWithNextFrame)");
    s_running = false;
  }
}

void StartOnMainThread() {
  if (s_running) return;
  if (!InitGl()) return;
  auto reg = g_Instance->VideoTrack().RegisterCurrentGraphicsContext();
  if (!reg) {
    MoonlightInstance::ClLogMessage("VT: RegisterCurrentGraphicsContext failed\n");
    SetInfo("VT HATA: grafik baglami video izine kaydedilemedi");
    return;
  }
  ShowCanvas(true);
  SetInfo("TR ceviri: video doku modu basladi, ilk kare bekleniyor...");
  EM_ASM({ window.vtFirstFrameSeen = false; window.vtFirstReadOk = false; });
  s_readOk = 0;
  s_readErrors = 0;
  s_drawErrors = 0;
  s_lastGlError = 0;
  s_running = true;
  s_lastReadMs = 0.0;
  s_drawnFrames = 0;
  s_fillErrors = 0;
  s_lastFillError = 0;
  s_readCount = 0;
  RequestFrame();
}

void StopOnMainThread() {
  s_running = false;
  if (s_animationFrameId) {
    emscripten_cancel_animation_frame(s_animationFrameId);
    s_animationFrameId = 0;
  }
  ShowCanvas(false);
}

}  // namespace

void VideoTextureStart() {
  emscripten_async_run_in_main_runtime_thread(EM_FUNC_SIG_V, StartOnMainThread);
}

uint32_t VideoTextureDrawnFrames() { return s_drawnFrames; }
uint32_t VideoTextureReadOk() { return s_readOk; }
uint32_t VideoTextureReadErrors() { return s_readErrors; }
uint32_t VideoTextureDrawErrors() { return s_drawErrors; }
int VideoTextureLastGlError() { return s_lastGlError; }
uint32_t VideoTextureFillErrors() { return s_fillErrors; }
int VideoTextureLastError() { return s_lastFillError; }

void VideoTextureStop() {
  emscripten_async_run_in_main_runtime_thread(EM_FUNC_SIG_V, StopOnMainThread);
}
