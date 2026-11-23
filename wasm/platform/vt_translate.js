// PS5 Türkçe çeviri — TV içinde canlı altyazı çevirisi (test sürümü)
//
// vtexture.cpp reads the bottom part of the drawn video frame about once a second and
// calls window.vtOnSubtitleFrame(pixels, width, height) with a copy of the RGBA pixels
// (GL row order, bottom row first). This file decides when the subtitle area shows new text, sends that
// area to EVREN (Türkiye, OpenAI-compatible) or Gemini as a small JPEG, and shows the Turkish
// translation over the picture. The API key is asked once and kept in this TV's localStorage
// only; a key starting with "AIza" is a Gemini key, anything else is an EVREN key.

(function () {
  'use strict';

  var KEY_STORAGE = 'vt_gemini_key';
  var EVREN_KEY_STORAGE = 'vt_evren_key';
  var EVREN_BASE = 'https://evren-llmapi.ssyz.org.tr/v1';
  var EVREN_READ_STORAGE = 'vt_evren_read_model';   // model that reads the picture (vision or OCR)
  var EVREN_CHAT_STORAGE = 'vt_evren_chat_model';   // model that translates OCR text
  var MODEL_STORAGE = 'vt_gemini_model';
  var DEFAULT_MODEL = 'gemini-flash-lite-latest';
  // Tried in order when a model is overloaded (503/429/500) or missing (404)
  var MODEL_CHAIN = ['gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'];

  var GRID_W = 96;            // change-detection grid
  var GRID_H = 16;
  var BRIGHT_LUMA = 185;      // subtitle text is near-white: every channel above this, little colour
  var MIN_TEXT_FRACTION = 0.0015;
  var STABLE_DIFF = 0.035;    // below this, two reads count as the same picture
  var NEW_TEXT_DIFF = 0.06;   // above this, the text differs from the last translated one
  var MIN_REQUEST_GAP_MS = 1200;
  var JPEG_WIDTH = 960;
  var REQUEST_TIMEOUT_MS = 8000;
  // A translation arrives 1-2 s after its line, so keep it readable for a while even if the
  // game has already hidden the original; a newer translation replaces it at once
  var MIN_SHOW_MS = 3000;          // never hide sooner than this
  var READ_MS_PER_CHAR = 70;       // longer lines stay longer
  var MAX_SHOW_MS = 9000;

  var PROMPT =
    'Bu görüntü bir video oyununun ekranının alt kısmıdır. Görüntüdeki oyun altyazısını ya da diyalog metnini oku ' +
    've doğal, akıcı Türkçeye çevir. Kurallar: Konuşmacı adı varsa "Ad: metin" biçimini koru ve adı çevirme. ' +
    'Windows görev çubuğu, saat, hava durumu, pencere başlığı, düğme ipuçları ve menü yazıları gibi oyun diyaloğu ' +
    'olmayan yazıları yok say. Okunacak diyalog yoksa yalnızca - işareti yaz. Açıklama ekleme, yalnızca çeviriyi yaz.';

  var state = {
    prevSig: null,
    stableCount: 0,
    lastSentSig: null,
    inFlight: false,
    lastRequestAt: 0,
    requests: 0,
    lastLatencyMs: 0,
    noThinkingConfig: {},     // models that rejected thinkingConfig
    model: null,
    lastError: '',
    lastReply: '',
    emptyReads: 0
  };

  var work = document.createElement('canvas');
  var workCtx = work.getContext('2d');
  var jpeg = document.createElement('canvas');
  var jpegCtx = jpeg.getContext('2d');

  function el(id) { return document.getElementById(id); }

  function setStatus(text) {
    var box = el('vt_info');
    if (!box) return;
    box.style.display = 'block';
    box.textContent = text;
  }

  function refreshStatus() {
    var parts = ['TR çeviri'];
    if (!getKey()) parts.push('API anahtarı yok');
    else if (state.inFlight) parts.push('çevriliyor... ' + ((Date.now() - state.lastRequestAt) / 1000).toFixed(0) + ' sn');
    else parts.push('hazır');
    if (state.requests) parts.push('istek ' + state.requests + ', son ' + (state.lastLatencyMs / 1000).toFixed(1) + ' sn');
    parts.push(getProvider() === 'evren' ? (/^EVREN/.test(state.model || '') ? state.model : 'EVREN') : getModel());
    if (state.lastReply) parts.push('yanıt: ' + state.lastReply.replace(/\s+/g, ' ').slice(0, 50));
    if (state.lastError) parts.push('HATA: ' + state.lastError);
    setStatus(parts.join(' | '));
  }

  var shownAt = 0;
  var showFor = 0;
  function showSubtitle(text) {
    var box = el('vt_sub');
    if (!box) return;
    if (!text) {
      box.style.display = 'none';
      box.textContent = '';
      shownAt = 0;
      return;
    }
    box.textContent = text;
    box.style.display = 'block';
    shownAt = Date.now();
    showFor = Math.min(MAX_SHOW_MS, Math.max(MIN_SHOW_MS, text.length * READ_MS_PER_CHAR));
  }
  // Hides the translation only after it has been readable long enough
  function hideSubtitleWhenRead() {
    if (shownAt && Date.now() - shownAt < showFor) return;
    showSubtitle('');
  }

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  function resetEvrenPicks() { evren.models = null; evren.vision = evren.ocr = evren.chat = ''; evren.blockedUntil = 0; }

  function getGeminiKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
  }
  function getEvrenKey() {
    try { return localStorage.getItem(EVREN_KEY_STORAGE) || ''; } catch (e) { return ''; }
  }
  // EVREN is tried first whenever its key is set; Gemini is kept as the fallback
  function getProvider() { return getEvrenKey() ? 'evren' : 'gemini'; }
  function getKey() { return getEvrenKey() || getGeminiKey(); }

  function getModel() {
    if (state.model) return state.model;
    try { state.model = localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL; } catch (e) { state.model = DEFAULT_MODEL; }
    return state.model;
  }

  // Grid of bright-pixel fractions; it follows the text, not the moving picture behind it
  function signature(rgba, width, height) {
    var sig = new Float32Array(GRID_W * GRID_H);
    var counts = new Uint32Array(GRID_W * GRID_H);
    var bright = 0;
    var total = 0;
    for (var y = 0; y < height; y += 2) {
      var gy = Math.min(GRID_H - 1, Math.floor(y * GRID_H / height));
      for (var x = 0; x < width; x += 2) {
        var i = (y * width + x) * 4;
        var r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        var hi = Math.max(r, g, b), lo = Math.min(r, g, b);
        var gx = Math.min(GRID_W - 1, Math.floor(x * GRID_W / width));
        var cell = gy * GRID_W + gx;
        counts[cell]++;
        total++;
        if (lo > BRIGHT_LUMA && hi - lo < 45) { sig[cell]++; bright++; }
      }
    }
    for (var c = 0; c < sig.length; c++) sig[c] = counts[c] ? sig[c] / counts[c] : 0;
    return { cells: sig, textFraction: total ? bright / total : 0 };
  }

  function diff(a, b) {
    if (!a || !b) return 1;
    var sum = 0;
    for (var i = 0; i < a.cells.length; i++) sum += Math.abs(a.cells[i] - b.cells[i]);
    return sum / a.cells.length * 10;
  }

  // pixels: a copy of the region in GL row order (bottom row first); flip it to image order
  function toImageData(pixels, width, height) {
    var out = new Uint8ClampedArray(width * height * 4);
    var row = width * 4;
    for (var y = 0; y < height; y++) {
      out.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    return new ImageData(out, width, height);
  }

  function makeJpegBase64(imageData) {
    work.width = imageData.width;
    work.height = imageData.height;
    workCtx.putImageData(imageData, 0, 0);
    var scale = Math.min(1, JPEG_WIDTH / imageData.width);
    jpeg.width = Math.round(imageData.width * scale);
    jpeg.height = Math.round(imageData.height * scale);
    jpegCtx.drawImage(work, 0, 0, jpeg.width, jpeg.height);
    return jpeg.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  function translateGemini(base64, attempt) {
    attempt = attempt || 0;
    var key = getGeminiKey();
    if (!key) return Promise.resolve(null);
    var body = {
      contents: [{
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: 'image/jpeg', data: base64 } }
        ]
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 256 }
    };
    var model = getModel();
    if (!state.noThinkingConfig[model]) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) +
      ':generateContent?key=' + encodeURIComponent(key);
    // XMLHttpRequest with a hard timeout, so one stuck request can never block the rest
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = REQUEST_TIMEOUT_MS;
      xhr.onload = function () {
        var json = null;
        try { json = JSON.parse(xhr.responseText); } catch (e) { json = { error: { message: 'yanıt okunamadı: ' + String(xhr.responseText).slice(0, 60) } }; }
        resolve({ status: xhr.status, json: json });
      };
      xhr.ontimeout = function () {
        resolve({ status: 504, json: { error: { message: 'zaman aşımı (' + REQUEST_TIMEOUT_MS / 1000 + ' sn), model: ' + model } } });
      };
      xhr.onerror = function () { reject(new Error('ağ hatası: Gemini sunucusuna ulaşılamadı (status ' + xhr.status + ')')); };
      xhr.send(JSON.stringify(body));
    }).then(function (r) {
      if (r.status === 200) {
        var cand = r.json.candidates && r.json.candidates[0];
        var parts = cand && cand.content && cand.content.parts || [];
        var text = parts.map(function (p) { return p.text || ''; }).join('').trim();
        state.lastError = '';
        try { localStorage.setItem(MODEL_STORAGE, model); } catch (e) {}
        return text;
      }
      var message = (r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status);
      // A generic 400 is usually the thinking setting this model does not accept: retry without it
      if (r.status === 400 && !/api key/i.test(message) && !state.noThinkingConfig[model]) {
        state.noThinkingConfig[model] = true;
        return translateGemini(base64, attempt);
      }
      if ([400, 404, 429, 500, 503, 504].indexOf(r.status) >= 0 && !/api key/i.test(message) && attempt < MODEL_CHAIN.length - 1) {
        // Move to the next model and keep it for later requests while it works
        var idx = MODEL_CHAIN.indexOf(getModel());
        state.model = MODEL_CHAIN[(idx + 1) % MODEL_CHAIN.length];
        state.lastError = 'model değişti: ' + state.model;
        return translateGemini(base64, attempt + 1);
      }
      if (r.status === 400 && /api key/i.test(message)) {
        try { localStorage.removeItem(KEY_STORAGE); } catch (e) {}
        message = 'API anahtarı geçersiz; uygulamayı yeniden açıp tekrar girin';
      }
      state.lastError = message.slice(0, 120);
      return null;
    });
  }


  // ---------- EVREN (OpenAI-compatible, data stays in Türkiye) ----------

  var evren = { models: null, vision: '', ocr: '', chat: '', loading: null, blockedUntil: 0, fullError: '' };
  var EVREN_BLOCK_MS = 5 * 60 * 1000;   // after a failure, go straight to Gemini for a while

  // Pulls the text out of the different OCR / chat response shapes
  function extractText(json) {
    if (!json) return '';
    if (json.pages && json.pages.length) return json.pages.map(function (p) { return p.markdown || p.text || ''; }).join('\n');
    if (typeof json.text === 'string') return json.text;
    if (typeof json.result === 'string') return json.result;
    if (typeof json.output_text === 'string') return json.output_text;
    if (json.data && typeof json.data.text === 'string') return json.data.text;
    var c = json.choices && json.choices[0];
    if (c && c.message && typeof c.message.content === 'string') return c.message.content;
    return '';
  }

  // EVREN's OCR model: the dedicated /ocr route first (Mistral-style), then chat completions
  function evrenOcr(model, dataUrl) {
    return xhrJson('POST', EVREN_BASE + '/ocr', getEvrenKey(), {
      model: model,
      document: { type: 'image_url', image_url: dataUrl }
    }).then(function (r) {
      if (r.status === 200) return stripThinking(extractText(r.json));
      var ocrRouteError = '/ocr: ' + errorText(r);
      return evrenChat(model, [
        { type: 'text', text: 'Görüntüdeki tüm yazıları satır satır, olduğu gibi yaz. Başka bir şey ekleme.' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ], 400).catch(function (err) {
        throw new Error(ocrRouteError + ' || /chat/completions: ' + String(err && err.message || err));
      });
    });
  }

  function xhrJson(method, url, key, body) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.setRequestHeader('Authorization', 'Bearer ' + key);
      if (body) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = REQUEST_TIMEOUT_MS * 2;
      xhr.onload = function () {
        var json = null;
        try { json = JSON.parse(xhr.responseText); } catch (e) { json = { error: { message: 'yanıt okunamadı: ' + String(xhr.responseText).slice(0, 60) } }; }
        resolve({ status: xhr.status, json: json });
      };
      xhr.ontimeout = function () { resolve({ status: 504, json: { error: { message: 'EVREN zaman aşımı' } } }); };
      xhr.onerror = function () { resolve({ status: 0, json: { error: { message: 'EVREN sunucusuna ulaşılamadı (ağ ya da CORS engeli)' } } }); };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  function errorText(r) {
    var e = r.json && (r.json.error || r.json.detail);
    var m = (e && (e.message || e)) || ('HTTP ' + r.status);
    return String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 400);
  }

  // Picks the models once: a vision chat model if EVREN has one, otherwise its OCR model plus a chat model
  function evrenModels() {
    if (evren.models) return Promise.resolve(evren);
    if (evren.loading) return evren.loading;
    evren.loading = xhrJson('GET', EVREN_BASE + '/models', getEvrenKey()).then(function (r) {
      evren.loading = null;
      if (r.status !== 200) throw new Error('EVREN modeller: ' + errorText(r));
      var list = (r.json && r.json.data) || [];
      var nonChat = /^(embedding|embeddings|rerank|ocr|asr|tts|speech|transcription|audio|decision|systemone|score)$/;
      var visionRe = /(^|[-_\/.])(vl|vision|omni|llava|pixtral|internvl|minicpm-v)([-_\/.]|$)|qwen[0-9.]*-?vl|gemma-?3|llama-?4|mistral-small-3/i;
      var slowRe = /r1|reason|think|coder|embed|guard/i;
      list.forEach(function (m) {
        if (!m || !m.id) return;
        var task = String(m.task || '').toLowerCase();
        var id = String(m.id);
        if (task === 'ocr' && !evren.ocr) evren.ocr = id;
        if (nonChat.test(task)) return;
        if (/vision|vlm|multimodal|image/.test(task) || visionRe.test(id)) { if (!evren.vision) evren.vision = id; }
        if (!slowRe.test(id) && !evren.chat) evren.chat = id;
      });
      if (!evren.chat) list.forEach(function (m) {
        var task = String(m && m.task || '').toLowerCase();
        if (m && m.id && !evren.chat && !nonChat.test(task)) evren.chat = String(m.id);
      });
      evren.models = list;
      // The user's own choices from the model list win over the automatic picks
      var readPick = lsGet(EVREN_READ_STORAGE), chatPick = lsGet(EVREN_CHAT_STORAGE);
      if (readPick) {
        var readModel = list.filter(function (m) { return m && m.id === readPick; })[0];
        if (readModel && String(readModel.task || '').toLowerCase() === 'ocr') { evren.ocr = readPick; evren.vision = ''; }
        else if (readModel) { evren.vision = readPick; }
      }
      if (chatPick && list.some(function (m) { return m && m.id === chatPick; })) evren.chat = chatPick;
      if (!evren.vision && !(evren.ocr && evren.chat)) throw new Error('EVREN\'de görüntü okuyabilen model bulunamadı; YEŞİL tuşla modelleri açıp seçin');
      return evren;
    }, function (err) { evren.loading = null; throw err; });
    return evren.loading;
  }

  function stripThinking(text) {
    return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  function evrenChat(model, content, maxTokens) {
    return xhrJson('POST', EVREN_BASE + '/chat/completions', getEvrenKey(), {
      model: model,
      messages: [{ role: 'user', content: content }],
      temperature: 0.2,
      max_tokens: maxTokens || 300,
      stream: false
    }).then(function (r) {
      if (r.status !== 200) throw new Error(model + ': ' + errorText(r));
      var c = r.json && r.json.choices && r.json.choices[0];
      return stripThinking(c && c.message && c.message.content);
    });
  }

  var TRANSLATE_PROMPT =
    'Aşağıdaki metin bir video oyununun ekranından okunmuştur. İçindeki oyun altyazısını ya da diyaloğu doğal, ' +
    'akıcı Türkçeye çevir. Konuşmacı adı varsa "Ad: metin" biçimini koru ve adı çevirme. Görev çubuğu, saat, ' +
    'hava durumu, pencere başlığı, düğme ipuçları gibi diyalog olmayan yazıları at. Diyalog yoksa yalnızca - yaz. ' +
    'Açıklama ekleme, yalnızca çeviriyi yaz.\n\nMetin:\n';

  function translateEvren(base64) {
    var dataUrl = 'data:image/jpeg;base64,' + base64;
    return evrenModels().then(function (m) {
      if (m.vision) {
        state.model = 'EVREN ' + m.vision;
        return evrenChat(m.vision, [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } }
        ], 300);
      }
      state.model = 'EVREN ' + m.ocr + ' + ' + m.chat;
      return evrenOcr(m.ocr, dataUrl).then(function (ocrText) {
        if (!ocrText || !/[A-Za-z]{2}/.test(ocrText)) return '-';
        return evrenChat(m.chat, TRANSLATE_PROMPT + ocrText, 300);
      });
    }).then(function (text) {
      state.lastError = '';
      return text;
    }, function (err) {
      var message = String(err && err.message || err);
      evren.fullError = message;
      evren.blockedUntil = Date.now() + EVREN_BLOCK_MS;
      if (/401|unauthor|api key|invalid.*key|yetki/i.test(message)) {
        message += ' (anahtarı ana ekranda YEŞİL tuşla değiştirin)';
      }
      state.lastError = message.slice(0, 140);
      return null;
    });
  }

  // Both keys are kept. EVREN goes first when its key is set; if it fails and a Gemini key is
  // set, the same picture goes to Gemini. With only one key, only that service is used.
  function translate(base64) {
    var hasGemini = !!getGeminiKey();
    // A recent EVREN failure sends lines straight to Gemini for a while, so they are not late
    var hasEvren = !!getEvrenKey() && !(hasGemini && Date.now() < evren.blockedUntil);
    if (!hasEvren) return translateGemini(base64, 0);
    return translateEvren(base64).then(function (text) {
      if (text !== null || !hasGemini) return text;
      var evrenError = state.lastError;
      return translateGemini(base64, 0).then(function (g) {
        if (g !== null) state.lastError = 'EVREN olmadı, 5 dk Gemini kullanılacak (hata ayrıntısı: YEŞİL tuş / F2)';
        return g;
      });
    });
  }

  function send(imageData, sig) {
    state.inFlight = true;
    state.lastRequestAt = Date.now();
    state.lastSentSig = sig;
    state.requests++;
    refreshStatus();
    var started = Date.now();
    var base64 = makeJpegBase64(imageData);
    translate(base64).then(function (text) {
      state.lastLatencyMs = Date.now() - started;
      if (text === null) return;
      state.lastReply = text;
      if (!text || text === '-' || text === '—') hideSubtitleWhenRead();
      else showSubtitle(text);
    }).catch(function (err) {
      state.lastError = String(err && err.message || err).slice(0, 120);
    }).then(function () {
      state.inFlight = false;
      refreshStatus();
    });
  }

  // Called from vtexture.cpp on the main thread with a copy of the subtitle region
  window.vtOnSubtitleFrame = function (pixels, width, height) {
    try {
      var imageData = toImageData(pixels, width, height);
      var sig = signature(imageData.data, width, height);

      if (sig.textFraction < MIN_TEXT_FRACTION) {
        // Nothing that looks like text for two reads in a row: clear the old translation
        state.prevSig = sig;
        state.stableCount = 0;
        state.emptyReads++;
        if (state.emptyReads >= 2) {
          state.lastSentSig = null;
          hideSubtitleWhenRead();
        }
        refreshStatus();
        return;
      }
      state.emptyReads = 0;

      var change = diff(sig, state.prevSig);
      state.stableCount = change < STABLE_DIFF ? state.stableCount + 1 : 0;
      state.prevSig = sig;

      var isNew = diff(sig, state.lastSentSig) > NEW_TEXT_DIFF;

      var gapOk = Date.now() - state.lastRequestAt >= MIN_REQUEST_GAP_MS;
      if (isNew && state.stableCount >= 1 && !state.inFlight && gapOk && getKey()) {
        send(imageData, sig);
      } else {
        refreshStatus();
      }
    } catch (e) {
      state.lastError = String(e && e.message || e).slice(0, 120);
      refreshStatus();
    }
  };

  // One-time API key prompt, shown on the app's first screen (not during a stream)
  function escapeHtml(t) {
    return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // Settings dialog: API key box plus the EVREN model list.
  // Remote: OK on the box opens the keyboard; Down moves into the list; in the list
  // OK = "okuma" (the model that reads the picture), Right = "çeviri" (translates OCR text),
  // Left = clear that row's choices; Back closes.
  function showKeyDialog(force) {
    if (el('vt_key_dialog')) return;
    if (getKey() && !force) return;
    var wrap = document.createElement('div');
    wrap.id = 'vt_key_dialog';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;';
    wrap.innerHTML =
      '<div style="background:#1e2230;color:#fff;padding:28px 40px;border-radius:12px;width:70%;max-height:90vh;display:flex;flex-direction:column;font:24px sans-serif;">' +
      '<div style="font-size:32px;margin-bottom:10px;">PS5 Türkçe çeviri — ayarlar (v14)</div>' +
      '<div id="vt_key_state" style="margin-bottom:8px;color:#9fe;"></div>' +
      '<div id="vt_evren_err" style="margin-bottom:8px;color:#f99;font-size:18px;word-break:break-all;max-height:160px;overflow:auto;"></div>' +
      '<div style="margin-bottom:12px;color:#ccc;font-size:20px;">Yeni anahtar: kutuyu seçip yazın ya da SmartThings\'ten yapıştırın, sonra Enter/Bitti. AIza ile başlayan anahtar Gemini, diğerleri EVREN olarak saklanır; ikisi de varsa önce EVREN, olmazsa Gemini kullanılır.</div>' +
      '<input id="vt_key_input" type="text" autocomplete="off" style="width:100%;box-sizing:border-box;font:24px monospace;padding:10px;border-radius:6px;border:2px solid #7CFC00;background:#11131a;color:#fff;" placeholder="EVREN ya da Gemini anahtarı">' +
      '<div id="vt_key_msg" style="margin-top:8px;color:#ffb347;min-height:28px;"></div>' +
      '<div style="margin-top:6px;font-size:20px;color:#ccc;">EVREN modelleri — Aşağı ok ile listeye inin. <b>Tamam</b> = okuma modeli (görüntüyü okur), <b>Sağ</b> = çeviri modeli (OCR metnini çevirir), <b>Sol</b> = seçimi kaldır, <b>Geri</b> = kapat.</div>' +
      '<div id="vt_model_list" style="margin-top:8px;overflow:auto;flex:1;min-height:120px;border:1px solid #333;border-radius:6px;"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    var input = el('vt_key_input');
    var listBox = el('vt_model_list');
    var msg = el('vt_key_msg');
    var models = [];      // [{id, task}], first row is "Otomatik"
    var sel = -1;         // -1 = the key box has focus

    function refreshKeyState() {
      var parts = [];
      parts.push('EVREN anahtarı: ' + (getEvrenKey() ? 'kayıtlı' : 'yok'));
      parts.push('Gemini anahtarı: ' + (getGeminiKey() ? 'kayıtlı' : 'yok'));
      parts.push('okuma: ' + (lsGet(EVREN_READ_STORAGE) || 'otomatik'));
      parts.push('çeviri: ' + (lsGet(EVREN_CHAT_STORAGE) || 'otomatik'));
      el('vt_key_state').textContent = parts.join('  |  ');
      el('vt_evren_err').textContent = evren.fullError ? ('Son EVREN hatası: ' + evren.fullError) : '';
    }

    function renderList() {
      var read = lsGet(EVREN_READ_STORAGE), chat = lsGet(EVREN_CHAT_STORAGE);
      listBox.innerHTML = models.map(function (m, i) {
        var tags = '';
        if (m.id === '') tags = (!read && !chat) ? ' <span style="color:#7CFC00">[seçili]</span>' : '';
        else {
          if (m.id === read) tags += ' <span style="color:#7CFC00">[OKUMA]</span>';
          if (m.id === chat) tags += ' <span style="color:#6cf">[ÇEVİRİ]</span>';
        }
        var bg = i === sel ? 'background:#2f6f2f;' : '';
        return '<div data-i="' + i + '" style="padding:6px 12px;' + bg + '">' +
          escapeHtml(m.id === '' ? 'Otomatik seçim (önerilen)' : m.id) +
          (m.task ? ' <span style="color:#999">(' + escapeHtml(m.task) + ')</span>' : '') + tags + '</div>';
      }).join('');
      var row = listBox.querySelector('[data-i="' + sel + '"]');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      refreshKeyState();
    }

    function loadModels() {
      if (!getEvrenKey()) { listBox.innerHTML = '<div style="padding:8px;color:#999">EVREN anahtarı girilince modeller burada listelenir.</div>'; return; }
      listBox.innerHTML = '<div style="padding:8px;color:#999">EVREN modelleri getiriliyor...</div>';
      xhrJson('GET', EVREN_BASE + '/models', getEvrenKey()).then(function (r) {
        if (r.status !== 200) {
          listBox.innerHTML = '<div style="padding:8px;color:#f88">Modeller alınamadı: ' + escapeHtml(errorText(r)) + '</div>';
          return;
        }
        var data = (r.json && r.json.data) || [];
        models = [{ id: '', task: '' }].concat(data.filter(function (m) { return m && m.id; }).map(function (m) {
          return { id: String(m.id), task: String(m.task || '') };
        }));
        msg.textContent = (models.length - 1) + ' model bulundu.';
        renderList();
      });
    }

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      window.removeEventListener('keydown', onKey, true);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
    // Saves the key if it looks valid. A Gemini key closes the dialog; an EVREN key loads the model list.
    function trySave(showMessage) {
      var value = (input.value || '').trim();
      if (!value) return false;
      if (value.length < 20) {
        if (showMessage) msg.textContent = 'Anahtar çok kısa görünüyor. Kutuyu seçip tekrar yazın.';
        return false;
      }
      input.value = '';
      if (/^AIza/.test(value)) {
        lsSet(KEY_STORAGE, value);
        msg.textContent = 'Gemini anahtarı kaydedildi.';
        refreshKeyState();
        if (!getEvrenKey()) close();
      } else {
        lsSet(EVREN_KEY_STORAGE, value);
        resetEvrenPicks();
        msg.textContent = 'EVREN anahtarı kaydedildi.';
        loadModels();
      }
      return true;
    }

    function choose(kind) {
      var m = models[sel];
      if (!m) return;
      if (m.id === '') { lsSet(EVREN_READ_STORAGE, ''); lsSet(EVREN_CHAT_STORAGE, ''); msg.textContent = 'Otomatik seçime dönüldü.'; }
      else if (kind === 'read') { lsSet(EVREN_READ_STORAGE, m.id); msg.textContent = 'Okuma modeli: ' + m.id; }
      else if (kind === 'chat') { lsSet(EVREN_CHAT_STORAGE, m.id); msg.textContent = 'Çeviri modeli: ' + m.id; }
      else {
        if (lsGet(EVREN_READ_STORAGE) === m.id) lsSet(EVREN_READ_STORAGE, '');
        if (lsGet(EVREN_CHAT_STORAGE) === m.id) lsSet(EVREN_CHAT_STORAGE, '');
        msg.textContent = 'Seçim kaldırıldı: ' + m.id;
      }
      resetEvrenPicks();
      renderList();
    }

    // Tizen's on-screen keyboard: "Done" sends 65376, "Cancel" sends 65385
    var DONE_KEYS = [13, 65376];
    var UP = 38, DOWN = 40, LEFT = 37, RIGHT = 39;
    function onKey(e) {
      if (closed) return;
      var code = e.keyCode;
      var inList = sel >= 0;
      if (code === 10009 || code === 27) {
        close();
      } else if (!inList) {
        if (DONE_KEYS.indexOf(code) >= 0) {
          if (!trySave(true) && document.activeElement !== input) input.focus();
        } else if (code === DOWN && models.length) {
          input.blur();
          sel = 0;
          renderList();
        } else {
          // Let typing reach the input, but keep the app's own navigation from reacting
          e.stopImmediatePropagation();
          return;
        }
      } else {
        if (code === DOWN) { sel = Math.min(models.length - 1, sel + 1); renderList(); }
        else if (code === UP) { sel = sel - 1; renderList(); if (sel < 0) input.focus(); }
        else if (DONE_KEYS.indexOf(code) >= 0) choose('read');
        else if (code === RIGHT) choose('chat');
        else if (code === LEFT) choose('clear');
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    // A complete Gemini key ("AIza" + 35 characters) is saved as soon as it is in the box,
    // so it works even if the TV keyboard sends no key event at all
    var poll = setInterval(function () {
      if (closed) { clearInterval(poll); return; }
      var value = (input.value || '').trim();
      if (/^AIza[0-9A-Za-z_\-]{35}$/.test(value)) trySave(false);
    }, 500);
    input.addEventListener('change', function () { trySave(false); });
    window.addEventListener('keydown', onKey, true);
    refreshKeyState();
    loadModels();
    setTimeout(function () { if (!getKey()) input.focus(); }, 300);
  }

  window.addEventListener('load', function () { setTimeout(function () { showKeyDialog(false); }, 1500); });

  // Green remote key (or F2 on a keyboard) on the app's screens, not during a stream,
  // opens the key dialog again so the key can be changed
  var GREEN_KEY = 404;
  var F2_KEY = 113;
  window.addEventListener('keydown', function (e) {
    if (e.keyCode !== GREEN_KEY && e.keyCode !== F2_KEY) return;
    var video = el('wasm_module');
    var streaming = video && video.style.display !== 'none';
    if (streaming || el('vt_key_dialog')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showKeyDialog(true);
  }, true);
})();
