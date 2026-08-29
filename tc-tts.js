/* ============ CosyVoice 语音合成（自建 GPU 服务器 API） ============ */
/* 接口形状与原腾讯云版本保持一致，调用方（caignick/sound/relax/process.js）无需改动：
   TC_TTS.synth(text, voiceType, speed) -> Promise<Blob[]>
   voiceType 为音色 id（101001 等），由服务端 CosyVoice2 用 instruct 指令渲染 */
window.TC_TTS = (function () {
  'use strict';

  var API_BASE = 'https://u1147881-c7kl-35a69bfe.bjb1.seetacloud.com:8443'; // CosyVoice API（AutoDL 自定义服务 6006 端口）
  var MAX_LEN = 200; // 单段上限（CosyVoice 支持长文本，适当放宽）

  /* 音色列表（id 与旧版一致） */
  var VOICES = [
    { id: 101001, label: '温柔女声', desc: '温柔舒缓' },
    { id: 101002, label: '通用女声', desc: '自然清晰' },
    { id: 101003, label: '甜美女声', desc: '轻柔甜美' },
    { id: 101004, label: '通用男声', desc: '平稳低沉' },
    { id: 101017, label: '沉稳男声', desc: '安定厚重' }
  ];

  /* 按标点断句拆分（保持语义完整） */
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

  /* 合成一段，返回 Blob(wav) */
  function synthOne(text, voiceType, speed) {
    var url = API_BASE + '/tts?text=' + encodeURIComponent(text) +
      '&voice=' + voiceType + '&speed=' + speed;
    return fetch(url).then(function (resp) {
      if (!resp.ok) throw new Error('TTS 服务返回 ' + resp.status);
      return resp.blob();
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
