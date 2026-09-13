// Parses the local model's plain-text, XML-tagged output into structured data. Ollama models
// don't get OpenAI-style strict json_schema enforcement, so instead of a schema the prompt
// (see prompt.js) constrains the model to an explicit <hooks>/<caption>/<hashtags> shape and
// this module regex-parses it back out — not a real XML parser, on purpose, because the
// model's raw output is never guaranteed to be well-formed XML.
function extractTag(text, tag) {
  const match = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1] : null;
}

function extractAll(text, tag) {
  const re = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const items = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const styleMatch = (m[1] || '').match(/style\s*=\s*"([^"]*)"/i);
    const itemText = m[2].trim();
    if (itemText) items.push({ text: itemText, style: styleMatch ? styleMatch[1].trim() : null });
  }
  return items;
}

// { hooks: [{text, style}], caption, hashtags: [] } — a missing/malformed section comes back
// empty rather than throwing; validator.js decides whether that's fatal.
function parseHooksCaptionHashtags(raw) {
  if (!raw || typeof raw !== 'string') return { hooks: [], caption: null, hashtags: [] };

  const hooksBlock = extractTag(raw, 'hooks');
  const hooks = extractAll(hooksBlock !== null ? hooksBlock : raw, 'hook');

  const caption = extractTag(raw, 'caption');

  const hashtagsBlock = extractTag(raw, 'hashtags');
  const hashtags = extractAll(hashtagsBlock !== null ? hashtagsBlock : raw, 'hashtag').map((h) => h.text);

  return { hooks, caption: caption ? caption.trim() : null, hashtags };
}

module.exports = { parseHooksCaptionHashtags, extractTag, extractAll };
