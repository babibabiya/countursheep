/* ============ 腾讯云语音合成（经云函数中转，自然中文音色） ============ */
window.TC_TTS = (function () {
  'use strict';

  var PROXY_URL = 'https://1476564237-4ur5dppr80.ap-beijing.tencentscf.com';
  var MAX_LEN = 140; // 中文单次上限约 150 字，留余量

  /* 音色列表（精品自然音色） */
  var VOICES = [
    { id: 101001, label: '智瑜', desc: '温柔女声' },
    { id: 101002, label: '智聆', desc: '通用女声' },
    { id: 101003, label: '智美', desc: '甜美女声' },
    { id: 101004, label: '智云', desc: '通用男声' },
    { id: 101017, label: '智鹏', desc: '沉稳男声' }
  ];

  /* 按 140 字上限断句拆分（在标点处断，保持语义完整） */
  function splitText(text) {
    var result = [];
    var cur = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      cur += ch;
      var isEnd = '。！？；.!?;'.indexOf(ch) >= 0;
      if (isEnd && cur.length >= 24) { result.push(cur); cur = ''; }
      else if (cur.length >= MAX_LEN) { result.push(cur); cur = ''; }
    }
    if (cur.trim()) result.push(cur);
    return result;
  }

  /* 合成一段（≤140 字），经云函数中转，返回 Blob(mp3) */
  function synthOne(text, voiceType, speed) {
    return fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, voiceType: voiceType, speed: speed })
    }).then(function (resp) {
      if (!resp.ok) throw new Error('代理返回 ' + resp.status);
      return resp.text();
    }).then(function (b64) {
      var clean = b64.replace(/\s/g, '');
      var bin = atob(clean);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: 'audio/mpeg' });
    });
  }

  /* 合成一段文本（自动拆分），返回 Promise<Blob[]> */
  function synth(text, voiceType, speed) {
    voiceType = voiceType || 101001;
    speed = (speed === undefined) ? -0.3 : speed; // 默认稍慢，适合助眠
    var chunks = splitText(text);
    var chain = Promise.resolve([]);
    chunks.forEach(function (c) {
      chain = chain.then(function (acc) {
        return synthOne(c, voiceType, speed).then(function (blob) { acc.push(blob); return acc; });
      });
    });
    return chain;
  }

  return { VOICES: VOICES, synth: synth };
})();
