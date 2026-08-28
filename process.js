/* 睡前流程控制器（隐形，无 UI，不改动页面内容）
   在各功能页面加载时检查 localStorage['sleep_process']，
   若处于流程中则计时，临近结束播放 AI 语音提醒，结束后自动跳转下一个活动。
   无页面（自定义）活动自动跳过；dur=0 的活动（白噪音/音乐/助眠）停在当前页不跳转。 */
(function() {
  'use strict';

  var REMINDER_TEXT = '这个环节快要结束了，我们准备进入下一个环节，你可以慢慢停下来，不用着急。';

  function readProc() {
    try {
      var raw = localStorage.getItem('sleep_process');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function gotoNext(proc) {
    for (var i = proc.index + 1; i < proc.activities.length; i++) {
      if (proc.activities[i].page) {
        proc.index = i;
        proc.startedAt = Date.now();
        try { localStorage.setItem('sleep_process', JSON.stringify(proc)); } catch (e) {}
        location.href = proc.activities[i].page;
        return;
      }
    }
    // 流程结束：停在当前页
    try { localStorage.removeItem('sleep_process'); } catch (e) {}
  }

  /* ===== 微软 Edge 神经网络语音（前端直连，无需本地中继） ===== */
  var EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  var EDGE_VER = '1-143.0.3650.75';
  var WIN_EPOCH = 11644473600;
  function edgeHexId() {
    var a = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function edgeJsDate() {
    var D = new Date();
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    return days[D.getUTCDay()] + ' ' + months[D.getUTCMonth()] + ' ' + p2(D.getUTCDate()) + ' ' +
      D.getUTCFullYear() + ' ' + p2(D.getUTCHours()) + ':' + p2(D.getUTCMinutes()) + ':' + p2(D.getUTCSeconds()) +
      ' GMT+0000 (Coordinated Universal Time)';
  }
  function edgeSecMsGec() {
    var t = Math.floor(Date.now() / 1000);
    t += WIN_EPOCH;
    t -= t % 300;
    t *= 10000000;
    var data = new TextEncoder().encode(String(t) + EDGE_TOKEN);
    return crypto.subtle.digest('SHA-256', data).then(function (hash) {
      return Array.prototype.map.call(new Uint8Array(hash), function (b) { return b.toString(16).padStart(2, '0'); }).join('').toUpperCase();
    });
  }
  function edgeTTS(text, voice, ratePct) {
    return edgeSecMsGec().then(function (gec) {
      return new Promise(function (resolve, reject) {
        var connId = edgeHexId();
        var qs = '/consumer/speech/synthesize/readaloud/edge/v1' +
          '?TrustedClientToken=' + EDGE_TOKEN +
          '&ConnectionId=' + connId +
          '&Sec-MS-GEC=' + gec +
          '&Sec-MS-GEC-Version=' + EDGE_VER;
        var ws = new WebSocket('wss://speech.platform.bing.com' + qs);
        var chunks = [];
        ws.binaryType = 'arraybuffer';
        var timer = setTimeout(function () { try { ws.close(); } catch (e) {} reject(new Error('Edge TTS 超时')); }, 30000);
        ws.onopen = function () {
          var ts = edgeJsDate();
          var cfg = 'X-Timestamp:' + ts + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
            JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } });
          ws.send(cfg);
          var rate = (ratePct > 0 ? '+' : '') + ratePct + '%';
          var ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
            "<voice name='" + voice + "'><prosody pitch='+0Hz' rate='" + rate + "' volume='+0%'>" + text + '</prosody></voice></speak>';
          var msg = 'X-RequestId:' + connId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + ts + 'Z\r\nPath:ssml\r\n\r\n' + ssml;
          ws.send(msg);
        };
        ws.onmessage = function (ev) {
          if (typeof ev.data === 'string') {
            if (ev.data.indexOf('Path:turn.end') >= 0) {
              clearTimeout(timer);
              try { ws.close(); } catch (e) {}
              resolve(new Blob(chunks, { type: 'audio/mpeg' }));
            }
          } else {
            var buf = new Uint8Array(ev.data);
            if (buf.length > 2) {
              var hlen = (buf[0] << 8) | buf[1];
              if (buf.length > 2 + hlen) chunks.push(buf.slice(2 + hlen));
            }
          }
        };
        ws.onerror = function () { clearTimeout(timer); reject(new Error('Edge TTS 连接失败')); };
        ws.onclose = function () { clearTimeout(timer); reject(new Error('Edge TTS 连接关闭')); };
      });
    });
  }

  /* 选择系统里最自然的中文音色 */
  function pickZhVoice() {
    try {
      if (!('speechSynthesis' in window)) return null;
      var voices = speechSynthesis.getVoices() || [];
      if (!voices.length) return null;
      var zh = voices.filter(function (v) { return /^zh|^cmn|chinese/i.test(v.lang || ''); });
      if (!zh.length) return null;
      var preferred = ['ting-ting', 'tingting', 'huihui', 'xiaoxiao', 'xiaoyi', 'yunxi', 'yunjian', 'meijia', 'sinji'];
      for (var i = 0; i < preferred.length; i++) {
        for (var j = 0; j < zh.length; j++) {
          if ((zh[j].name || '').toLowerCase().indexOf(preferred[i]) >= 0) return zh[j];
        }
      }
      var local = zh.filter(function (v) { return v.localService; });
      if (local.length) return local[0];
      return zh[0];
    } catch (e) { return null; }
  }

  /* 系统语音兜底：Edge 失败/离线时用 speechSynthesis，保证出声 */
  function speakSystem(after) {
    var done = false;
    function finish() { if (!done) { done = true; after(); } }
    try {
      if ('speechSynthesis' in window) {
        var u = new SpeechSynthesisUtterance(REMINDER_TEXT);
        var v = pickZhVoice();
        if (v) u.voice = v;
        u.lang = 'zh-CN';
        u.rate = 0.95;
        u.onend = finish;
        u.onerror = finish;
        try { speechSynthesis.cancel(); } catch (e) {}
        speechSynthesis.speak(u);
        // 兜底：最多 12 秒后强制结束
        setTimeout(function () { if (!done) { try { speechSynthesis.cancel(); } catch (e) {} finish(); } }, 12000);
        return;
      }
    } catch (e) {}
    finish();
  }

  /* 播放提醒语音：Edge 直连失败则降级系统语音，始终调用 after */
  function playReminder(after) {
    var done = false;
    function finish() { if (!done) { done = true; after(); } }
    try {
      edgeTTS(REMINDER_TEXT, 'zh-CN-XiaoxiaoNeural', -5).then(function (blob) {
        if (done) return;
        var url = URL.createObjectURL(blob);
        var a = new Audio(url);
        a.onended = function () { try { URL.revokeObjectURL(url); } catch (e) {} finish(); };
        a.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) {} speakSystem(finish); };
        a.play().catch(function () { speakSystem(finish); });
        // 兜底：最多 20 秒后强制结束
        setTimeout(function () { if (!done) { finish(); } }, 20000);
      }).catch(function () {
        speakSystem(finish);
      });
    } catch (e) {
      speakSystem(finish);
    }
  }

  var proc = readProc();
  if (!proc || !Array.isArray(proc.activities) || proc.activities.length === 0) return;
  var act = proc.activities[proc.index];
  if (!act) { try { localStorage.removeItem('sleep_process'); } catch (e) {} return; }

  var durSec = (act.dur || 0) * 60;
  if (durSec <= 0) return; // 无时长活动（白噪音/音乐/助眠）停在当前页

  var elapsed = Math.floor((Date.now() - proc.startedAt) / 1000);
  var remain = durSec - elapsed;
  if (remain <= 0) { gotoNext(proc); return; }

  // 最后 60 秒：播语音提醒，结束后跳转
  var remindIn = Math.max(0, remain - 60);
  setTimeout(function () {
    playReminder(function () { gotoNext(proc); });
  }, remindIn * 1000);
})();
