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

  /* ===== 腾讯云语音合成（自然中文音色，国内可直连） ===== */
  function edgeTTS(text, voice, ratePct) {
    if (!window.TC_TTS) return Promise.reject(new Error('TC_TTS 未加载'));
    var speed = Math.max(-2, Math.min(6, Math.round(ratePct / 50)));
    return TC_TTS.synth(text, voice, speed).then(function (blobs) {
      return blobs[0];
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
      edgeTTS(REMINDER_TEXT, 101001, -5).then(function (blob) {
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
