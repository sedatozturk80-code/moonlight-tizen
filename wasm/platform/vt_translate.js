// PS5 Türkçe çeviri — TV içinde canlı altyazı çevirisi (test sürümü)
//
// vtexture.cpp reads the bottom part of the drawn video frame about once a second and
// calls window.vtOnSubtitleFrame(pixels, width, height) with a copy of the RGBA pixels
// (GL row order, bottom row first). This file decides when the subtitle area shows new text, sends that
// area to Gemini as a small JPEG, and shows the Turkish translation over the picture.
// The Gemini API key is asked once and kept in this TV's localStorage only.

(function () {
  'use strict';

  var KEY_STORAGE = 'vt_gemini_key';
  var MODEL_STORAGE = 'vt_gemini_model';
  var DEFAULT_MODEL = 'gemini-flash-latest';
  var FALLBACK_MODEL = 'gemini-2.5-flash';

  var GRID_W = 96;            // change-detection grid
  var GRID_H = 16;
  var BRIGHT_LUMA = 170;      // subtitle text is usually white or light
  var MIN_TEXT_FRACTION = 0.0015;
  var STABLE_DIFF = 0.035;    // below this, two reads count as the same picture
  var NEW_TEXT_DIFF = 0.06;   // above this, the text differs from the last translated one
  var MIN_REQUEST_GAP_MS = 1200;
  var JPEG_WIDTH = 960;

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
    useThinkingConfig: true,
    model: null,
    lastError: ''
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
    else if (state.inFlight) parts.push('çevriliyor...');
    else parts.push('hazır');
    if (state.requests) parts.push('istek ' + state.requests + ', son ' + (state.lastLatencyMs / 1000).toFixed(1) + ' sn');
    if (state.lastError) parts.push('HATA: ' + state.lastError);
    setStatus(parts.join(' | '));
  }

  function showSubtitle(text) {
    var box = el('vt_sub');
    if (!box) return;
    if (!text) {
      box.style.display = 'none';
      box.textContent = '';
      return;
    }
    box.textContent = text;
    box.style.display = 'block';
  }

  function getKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
  }

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
        var luma = (rgba[i] * 3 + rgba[i + 1] * 6 + rgba[i + 2]) / 10;
        var gx = Math.min(GRID_W - 1, Math.floor(x * GRID_W / width));
        var cell = gy * GRID_W + gx;
        counts[cell]++;
        total++;
        if (luma > BRIGHT_LUMA) { sig[cell]++; bright++; }
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

  function translate(base64) {
    var key = getKey();
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
    if (state.useThinkingConfig) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(getModel()) +
      ':generateContent?key=' + encodeURIComponent(key);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (json) { return { status: res.status, json: json }; });
    }).then(function (r) {
      if (r.status === 200) {
        var cand = r.json.candidates && r.json.candidates[0];
        var parts = cand && cand.content && cand.content.parts || [];
        var text = parts.map(function (p) { return p.text || ''; }).join('').trim();
        state.lastError = '';
        return text;
      }
      var message = (r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status);
      if (r.status === 400 && /thinking/i.test(message) && state.useThinkingConfig) {
        state.useThinkingConfig = false;
        return translate(base64);
      }
      if (r.status === 404 && getModel() !== FALLBACK_MODEL) {
        state.model = FALLBACK_MODEL;
        return translate(base64);
      }
      if (r.status === 400 && /api key/i.test(message)) {
        try { localStorage.removeItem(KEY_STORAGE); } catch (e) {}
        message = 'API anahtarı geçersiz; uygulamayı yeniden açıp tekrar girin';
      }
      state.lastError = message.slice(0, 120);
      return null;
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
      if (!text || text === '-' || text === '—') showSubtitle('');
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
        // Nothing that looks like text: clear the old translation
        state.prevSig = sig;
        state.stableCount = 0;
        state.lastSentSig = null;
        showSubtitle('');
        refreshStatus();
        return;
      }

      var change = diff(sig, state.prevSig);
      state.stableCount = change < STABLE_DIFF ? state.stableCount + 1 : 0;
      state.prevSig = sig;

      var isNew = diff(sig, state.lastSentSig) > NEW_TEXT_DIFF;
      if (isNew && change >= STABLE_DIFF) showSubtitle(''); // the text is changing; hide the stale line

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
  function showKeyDialog() {
    if (getKey() || el('vt_key_dialog')) return;
    var wrap = document.createElement('div');
    wrap.id = 'vt_key_dialog';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    wrap.innerHTML =
      '<div style="background:#1e2230;color:#fff;padding:36px 44px;border-radius:12px;width:60%;font:26px sans-serif;">' +
      '<div style="font-size:34px;margin-bottom:14px;">PS5 Türkçe çeviri</div>' +
      '<div style="margin-bottom:18px;color:#ccc;">Gemini API anahtarınızı girin. Kumandanın Tamam tuşuyla kutuyu seçip klavyeyle yazabilir ya da telefondaki SmartThings uygulamasından yapıştırabilirsiniz. Bitince klavyede Bitti\'ye basın. Atlamak için Geri.</div>' +
      '<input id="vt_key_input" type="text" autocomplete="off" style="width:100%;font:26px monospace;padding:12px;border-radius:6px;border:2px solid #7CFC00;background:#11131a;color:#fff;" placeholder="AIza...">' +
      '<div id="vt_key_msg" style="margin-top:12px;color:#ffb347;"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    var input = el('vt_key_input');

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
      try { localStorage.setItem(KEY_STORAGE, value); } catch (err) {}
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
    // When the keyboard closes the box loses focus or fires change: save then too
    input.addEventListener('change', function () { trySave(false); });
    input.addEventListener('blur', function () { setTimeout(function () { trySave(false); }, 100); });
    window.addEventListener('keydown', onKey, true);
    setTimeout(function () { input.focus(); }, 300);
  }

  window.addEventListener('load', function () { setTimeout(showKeyDialog, 1500); });
})();
