const fs = require('fs');

// True color emoji glyphs (🔥😂❤️) can't be rasterized by this local caption renderer
// (libass/freetype here has no color-bitmap font support). These are colored, verified-
// renderable symbol glyphs used as stand-ins instead of a missing-glyph box.
const COLOR = {
  red: '&H000000FF&', yellow: '&H0000FFFF&', green: '&H0000FF00&',
  blue: '&H00FF0000&', orange: '&H0000A5FF&',
};

const EMOJI_MAP = [
  [/\b(fire|lit|insane|crazy|mental|wild)\b/, '‼', COLOR.orange],
  [/\b(wow|omg|oh my god)\b/, '‼', COLOR.yellow],
  [/\blove\b/, '♥', COLOR.red],
  [/\b(funny|lol|haha|hilarious|laugh(ing)?)\b/, '☺', COLOR.yellow],
  [/\b(win|wins|winner|best|champion)\b/, '★', COLOR.yellow],
  [/\b(amazing|incredible|awesome|huge|boom)\b/, '★', COLOR.orange],
  [/\b(no|never)\b/, '✗', COLOR.red],
  [/\b(money|cash|rich)\b/, '♦', COLOR.green],
  [/\b(shock(ing)?|scary|scared)\b/, '‼', COLOR.red],
  [/\byes\b/, '✓', COLOR.green],
  [/\b(angry|mad)\b/, '☹', COLOR.red],
  [/\b(sad|cry(ing)?)\b/, '☹', COLOR.blue],
];

const THEMES = {
  bold: { label: 'Bold Karaoke', fontName: 'Arial Black', fontSize: 68, primary: '&H0000FFFF', outline: '&H00000000', alignment: 2, marginV: 220, uppercase: true, mode: 'word' },
  clean: { label: 'Clean Subtitle', fontName: 'Helvetica', fontSize: 42, primary: '&H00FFFFFF', outline: '&H00000000', alignment: 2, marginV: 130, uppercase: false, mode: 'phrase' },
  meme: { label: 'Meme Caps', fontName: 'Impact', fontSize: 60, primary: '&H00FFFFFF', outline: '&H00000000', alignment: 8, marginV: 110, uppercase: true, mode: 'phrase' },
};

function emojiFor(word) {
  const w = word.toLowerCase().replace(/[^a-z']/g, '');
  for (const [re, symbol, color] of EMOJI_MAP) {
    if (re.test(w)) return `{\\c${color}}${symbol}{\\c}`;
  }
  return null;
}

function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${ss.toFixed(2).padStart(5, '0')}`;
}

function escapeAss(text) {
  return text.replace(/\\/g, '/').replace(/[{}]/g, '');
}

// Rough glyph-width estimate (bold/condensed fonts run wider per character than this at small
// sizes, narrower at large sizes, but this is close enough to keep captions from running off
// the sides of a 1080px-wide frame).
function estimateWidth(text, fontSize) {
  return text.length * fontSize * 0.72;
}

// Shrinks the font size for this specific line until it fits within maxWidthPx, so a long
// word/phrase can't push text past the left/right edges of the frame.
function fitFontSize(text, baseFontSize, maxWidthPx, minFontSize = 30) {
  let fs = baseFontSize;
  while (fs > minFontSize && estimateWidth(text, fs) > maxWidthPx) {
    fs -= 4;
  }
  return fs;
}

// Maps a clip-local time (pre-effect) to output time, accounting for slow-mo segments so
// captions stay in sync even when part of the clip is retimed.
function remapTime(t, segments) {
  let acc = 0;
  for (const seg of segments) {
    const rate = seg.rate || 1;
    const outLen = (seg.end - seg.start) / rate;
    if (t <= seg.end) {
      const within = Math.max(0, t - seg.start);
      return acc + within / rate;
    }
    acc += outLen;
  }
  return acc;
}

function groupPhrases(words, maxWords = 5, pauseGap = 0.45) {
  const phrases = [];
  let cur = [];
  for (const w of words) {
    if (cur.length && (w.start - cur[cur.length - 1].end > pauseGap || cur.length >= maxWords)) {
      phrases.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) phrases.push(cur);
  return phrases;
}

// words: [{start,end,text}] in clip-LOCAL time (0..clipLength), already filtered to the clip.
// segments: the render segment plan for this clip (for time remapping around slow-mo).
// Returns a path to a generated .ass file, or null if there are no usable words.
function buildCaptionsAss({ words, segments, theme = 'bold', emojis = true, outW = 1080, outH = 1920, outPath }) {
  const cfg = THEMES[theme] || THEMES.bold;
  const clean = words.filter((w) => w.text && w.text.trim());
  if (!clean.length) return null;

  const MARGIN_LR = 90;
  const maxWidthPx = outW - MARGIN_LR * 2;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${outW}
PlayResY: ${outH}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${cfg.fontName},${cfg.fontSize},${cfg.primary},&H000000FF,${cfg.outline},&H00000000,1,0,0,0,100,100,0,0,1,4,0,${cfg.alignment},${MARGIN_LR},${MARGIN_LR},${cfg.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // `text` here must already be a mix of escaped plain text and raw (unescaped) ASS tags
  // like the emoji color overrides emojiFor() returns. `plainForFit` is the un-escaped plain
  // text used only to compute a font size that keeps the line inside the frame width.
  const lines = [];
  const emitLine = (startT, endT, text, plainForFit) => {
    const outStart = remapTime(startT, segments);
    const outEnd = remapTime(endT, segments);
    if (outEnd - outStart < 0.05) return;
    const fitSize = fitFontSize(plainForFit, cfg.fontSize, maxWidthPx);
    const sizeTag = fitSize < cfg.fontSize ? `{\\fs${fitSize}}` : '';
    lines.push(`Dialogue: 0,${assTime(outStart)},${assTime(outEnd)},Main,,0,0,0,,${sizeTag}${text}`);
  };

  if (cfg.mode === 'word') {
    for (const w of clean) {
      const plain = cfg.uppercase ? w.text.toUpperCase() : w.text;
      let text = escapeAss(plain);
      if (emojis) {
        const e = emojiFor(w.text);
        if (e) text += ` ${e}`;
      }
      emitLine(w.start, w.end, text, plain);
    }
  } else {
    const phrases = groupPhrases(clean);
    for (const phrase of phrases) {
      let plain = phrase.map((w) => w.text).join(' ');
      if (cfg.uppercase) plain = plain.toUpperCase();
      let text = escapeAss(plain);
      if (emojis) {
        for (const w of phrase) {
          const e = emojiFor(w.text);
          if (e) {
            text += ` ${e}`;
            break;
          }
        }
      }
      emitLine(phrase[0].start, phrase[phrase.length - 1].end, text, plain);
    }
  }

  if (!lines.length) return null;
  fs.writeFileSync(outPath, header + lines.join('\n') + '\n');
  return outPath;
}

module.exports = { buildCaptionsAss, THEMES, remapTime };
