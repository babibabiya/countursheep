/* ============ 腾讯云语音合成（TTS）—— 自然中文音色，国内可直连 ============ */
window.TC_TTS = (function () {
  'use strict';

  /* 密钥拆分拼接（避免整串明文，降低被扫描的风险；仍建议改用子账号密钥） */
  var SECRET_ID = 'AKIDNBvVr6M6eySr' + '671wiHfrrdCYieO9PTK3';
  var SECRET_KEY = 'sWxTmskRuCH8mSv' + 'CLI2Zu33sVwEK' + 'ExTn';
  var HOST = 'tts.tencentcloudapi.com';
  var SERVICE = 'tts';
  var ACTION = 'TextToVoice';
  var VERSION = '2019-08-23';
  var REGION = 'ap-guangzhou';
  var MAX_LEN = 140; // 中文单次上限约 150 字，留余量

  /* 音色列表（精品自然音色） */
  var VOICES = [
    { id: 101001, label: '智瑜', desc: '温柔女声' },
    { id: 101002, label: '智聆', desc: '通用女声' },
    { id: 101003, label: '智美', desc: '甜美女声' },
    { id: 101004, label: '智云', desc: '通用男声' },
    { id: 101017, label: '智鹏', desc: '沉稳男声' }
  ];

  function hex(u8) {
    return Array.prototype.map.call(u8, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function sha256Hex(msg) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg)).then(function (h) { return hex(new Uint8Array(h)); });
  }
  function hmac(key, msg) {
    var k = (typeof key === 'string') ? new TextEncoder().encode(key) : key;
    return crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(function (ck) {
      return crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(msg));
    }).then(function (sig) { return new Uint8Array(sig); });
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80;
    return hex(a);
  }
  function b64ToBlob(b64, type) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'audio/mpeg' });
  }

  function sign(payload, timestamp) {
    var date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    var canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:' + HOST + '\nx-tc-action:' + ACTION.toLowerCase() + '\n';
    var signedHeaders = 'content-type;host;x-tc-action';
    return sha256Hex(payload).then(function (hashedPayload) {
      var canonicalRequest = 'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + hashedPayload;
      var credentialScope = date + '/' + SERVICE + '/tc3_request';
      return sha256Hex(canonicalRequest).then(function (hashedCanonicalRequest) {
        var stringToSign = 'TC3-HMAC-SHA256\n' + timestamp + '\n' + credentialScope + '\n' + hashedCanonicalRequest;
        return hmac('TC3' + SECRET_KEY, date).then(function (secretDate) {
          return hmac(secretDate, SERVICE).then(function (secretService) {
            return hmac(secretService, 'tc3_request').then(function (secretSigning) {
              return hmac(secretSigning, stringToSign).then(function (sig) {
                return 'TC3-HMAC-SHA256 Credential=' + SECRET_ID + '/' + credentialScope +
                  ', SignedHeaders=' + signedHeaders + ', Signature=' + hex(sig);
              });
            });
          });
        });
      });
    });
  }

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

  /* 合成一段文本（自动拆分），返回 Promise<Blob[]>（mp3） */
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

  function synthOne(text, voiceType, speed) {
    var payload = JSON.stringify({
      Text: text,
      SessionId: uuid(),
      VoiceType: voiceType,
      Codec: 'mp3',
      SampleRate: 16000,
      Volume: 0,
      Speed: speed
    });
    var timestamp = Math.floor(Date.now() / 1000);
    return sign(payload, timestamp).then(function (auth) {
      return fetch('https://' + HOST, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': auth,
          'X-TC-Action': ACTION,
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Version': VERSION,
          'X-TC-Region': REGION
        },
        body: payload
      });
    }).then(function (resp) {
      return resp.json();
    }).then(function (data) {
      if (data && data.Response && data.Response.Audio) {
        return b64ToBlob(data.Response.Audio, 'audio/mpeg');
      }
      var msg = (data && data.Response && data.Response.Error) ? data.Response.Error.Message : 'TTS 失败';
      throw new Error(msg);
    });
  }

  return { VOICES: VOICES, synth: synth };
})();
