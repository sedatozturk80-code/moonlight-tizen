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

  var evren = { models: null, vision: '', ocr: '', chat: '', loading: null };

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
    return String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 120);
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
      if (!evren.vision && !(evren.ocr && evren.chat)) throw new Error('EVREN\'de görüntü okuyabilen model bulunamadı');
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
      return evrenChat(m.ocr, [
        { type: 'text', text: 'Görüntüdeki tüm yazıları satır satır, olduğu gibi yaz. Başka bir şey ekleme.' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ], 400).then(function (ocrText) {
        if (!ocrText || !/[A-Za-z]{2}/.test(ocrText)) return '-';
        return evrenChat(m.chat, TRANSLATE_PROMPT + ocrText, 300);
      });
    }).then(function (text) {
      state.lastError = '';
      return text;
    }, function (err) {
      var message = String(err && err.message || err);
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
    var hasEvren = !!getEvrenKey();
    var hasGemini = !!getGeminiKey();
    if (!hasEvren) return translateGemini(base64, 0);
    return translateEvren(base64).then(function (text) {
      if (text !== null || !hasGemini) return text;
      var evrenError = state.lastError;
      return translateGemini(base64, 0).then(function (g) {
        if (g !== null) state.lastError = 'EVREN olmadı, Gemini kullanıldı (' + evrenError.slice(0, 60) + ')';
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
  function showKeyDialog(force) {
    if (el('vt_key_dialog')) return;
    if (getKey() && !force) return;
    var wrap = document.createElement('div');
    wrap.id = 'vt_key_dialog';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    wrap.innerHTML =
      '<div style="background:#1e2230;color:#fff;padding:36px 44px;border-radius:12px;width:60%;font:26px sans-serif;">' +
      '<div style="font-size:34px;margin-bottom:14px;">PS5 Türkçe çeviri</div>' +
      '<div style="margin-bottom:10px;color:#9fe;">İki anahtarı da kaydedebilirsiniz: AIza ile başlayan anahtar Gemini, diğerleri EVREN olarak saklanır. İkisi de varsa önce EVREN denenir, olmazsa Gemini kullanılır. İkinci anahtar için ana ekranda YEŞİL tuşa basın.</div>' +
      '<div style="margin-bottom:18px;color:#ccc;">EVREN ya da Gemini API anahtarınızı girin. Kumandanın Tamam tuşuyla kutuyu seçip klavyeyle yazabilir ya da telefondaki SmartThings uygulamasından yapıştırabilirsiniz. Anahtar tamamlanınca bu pencere kendiliğinden kapanır. Atlamak için Geri. Anahtarı sonra değiştirmek için ana ekranda kumandanın YEŞİL tuşuna (ya da klavyede F2) basın. (v12)</div>' +
      '<input id="vt_key_input" type="text" autocomplete="off" style="width:100%;font:26px monospace;padding:12px;border-radius:6px;border:2px solid #7CFC00;background:#11131a;color:#fff;" placeholder="AIza...">' +
      '<div id="vt_key_msg" style="margin-top:12px;color:#ffb347;"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    var input = el('vt_key_input');
    if (force && getKey()) input.value = getKey();
    // Show the box empty on a forced open so a different key can be typed or pasted
    if (force) input.value = '';

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      window.removeEventListener('keydown', onKey, true);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
    // Saves the key if it looks valid; returns true when the dialog was closed
    function trySave(showMessage) {
      var value = (input.value || '').trim();
      if (value.length < 20) {
        if (showMessage) el('vt_key_msg').textContent = 'Anahtar çok kısa görünüyor. Kutuyu seçip tekrar yazın.';
        return false;
      }
      try {
        if (/^AIza/.test(value)) localStorage.setItem(KEY_STORAGE, value);
        else { localStorage.setItem(EVREN_KEY_STORAGE, value); evren.models = null; evren.vision = evren.ocr = evren.chat = ''; }
      } catch (err) {}
      close();
      return true;
    }
    // Tizen's on-screen keyboard: "Done" sends 65376, "Cancel" sends 65385
    var DONE_KEYS = [13, 65376];
    var BACK_KEYS = [10009, 27, 65385];
    function onKey(e) {
      if (closed) return;
      var code = e.keyCode;
      if (DONE_KEYS.indexOf(code) >= 0) {
        // With the keyboard closed, OK on an empty or short box opens the keyboard again
        if (!trySave(true) && document.activeElement !== input) input.focus();
      } else if (BACK_KEYS.indexOf(code) >= 0 && code !== 65385) {
        close();
      } else {
        // Let typing reach the input, but keep the app's own navigation from reacting
        e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    // A complete Gemini key ("AIza" + 35 characters) is saved as soon as it is in the box,
    // so the dialog closes even if the TV keyboard sends no key event at all
    var poll = setInterval(function () {
      if (closed) { clearInterval(poll); return; }
      var value = (input.value || '').trim();
      if (/^AIza[0-9A-Za-z_\-]{35}$/.test(value)) {  // only Gemini keys have a known shape
        clearInterval(poll);
        trySave(false);
      }
    }, 500);
    // When the keyboard closes the box loses focus or fires change: save then too
    input.addEventListener('change', function () { trySave(false); });
    input.addEventListener('blur', function () { setTimeout(function () { trySave(false); }, 100); });
    window.addEventListener('keydown', onKey, true);
    setTimeout(function () { input.focus(); }, 300);
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
