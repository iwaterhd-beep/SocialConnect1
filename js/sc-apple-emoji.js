/**
 * Convierte caracteres emoji (Unicode) en imágenes PNG del set oficial de Apple
 * para que se vean igual en cualquier dispositivo. Usa emoji-datasource-apple
 * servido por jsDelivr (imágenes oficiales de Apple bajo su licencia de emoji).
 */
(function () {
  var EMOJI_CDN = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/';
  var BASE_CLS = 'sc-apple-emoji';
  var STYLE_ID = 'sc-apple-emoji-style';
  var CSS =
    '.' +
    BASE_CLS +
    '{width:1em;height:1em;display:inline-block;vertical-align:-0.125em;object-fit:contain;line-height:1}';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  var EMOJI_RE =
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]+/gu;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c];
    });
  }

  function emojiToFileName(emoji) {
    var parts = [];
    for (var i = 0; i < emoji.length; i++) {
      var code = emoji.codePointAt(i);
      if (code === 0xfe0f) continue;
      parts.push(code.toString(16).padStart(4, '0'));
      if (code > 0xffff) i++;
    }
    return parts.join('-');
  }

  function emojiImg(emoji, cls) {
    var name = emojiToFileName(emoji);
    var clsAttr = cls
      ? ' class="' + BASE_CLS + ' ' + escapeHtml(cls) + '"'
      : ' class="' + BASE_CLS + '"';
    return (
      '<img src="' + EMOJI_CDN + name + '.png" alt="' + escapeHtml(emoji) + '" loading="lazy" decoding="async"' + clsAttr + ' />'
    );
  }

  function toHtml(text, cls) {
    return String(text == null ? '' : text).replace(EMOJI_RE, function (m) {
      return emojiImg(m, cls);
    });
  }

  var api = {
    src: function (emoji) {
      return EMOJI_CDN + emojiToFileName(String(emoji || '')) + '.png';
    },
    img: emojiImg,
    html: toHtml,
    escapeHtml: escapeHtml,
    init: ensureStyle,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', api.init);
  } else {
    api.init();
  }

  window.scAppleEmoji = api;
})();
