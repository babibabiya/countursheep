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

  function speakWeb(after) {
    var finished = false;
    function finish() { if (!finished) { finished = true; after(); } }
    try {
      if ('speechSynthesis' in window) {
        var u = new SpeechSynthesisUtterance(REMINDER_TEXT);
        u.lang = 'zh-CN';
        u.onend = finish;
        u.onerror = finish;
        speechSynthesis.speak(u);
        // 兜底：最多 12 秒后强制结束
        setTimeout(function() {
          if (!finished) { try { speechSynthesis.cancel(); } catch (e) {} finish(); }
        }, 12000);
        return;
      }
    } catch (e) {}
    finish();
  }

  function playReminder(after) {
    try {
      fetch('http://127.0.0.1:8418/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: REMINDER_TEXT, voice: 'zh-CN-XiaoxiaoNeural', rate: -5 })
      }).then(function (r) {
        if (!r.ok) throw new Error('tts ' + r.status);
        return r.blob();
      }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = new Audio(url);
        a.onended = function () { try { URL.revokeObjectURL(url); } catch (e) {} after(); };
        a.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) {} speakWeb(after); };
        a.play().catch(function () { speakWeb(after); });
      }).catch(function () {
        speakWeb(after);
      });
    } catch (e) {
      speakWeb(after);
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
