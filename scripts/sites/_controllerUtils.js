'use strict';

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeMarkdown(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

function truncate(text, max = 200) {
  const value = normalizeWhitespace(text);
  if (!value || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function toAbsoluteUrl(baseUrl, href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return raw;
  }
}

function uniqueBy(items, keyFn) {
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function joinMeta(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map(part => normalizeWhitespace(part))
    .filter(Boolean)
    .join(' | ');
}

function escapeMarkdownLabel(text) {
  return normalizeWhitespace(text).replace(/\]/g, '\\]');
}

function formatMarkdownLink(label, href) {
  const safeHref = String(href || '').trim();
  const safeLabel = escapeMarkdownLabel(label || safeHref || 'Ссылка');
  return safeHref ? `[${safeLabel}](${safeHref})` : safeLabel;
}

function renderOrderedItems(items, options = {}) {
  const {
    titleField = 'title',
    hrefField = 'href',
    metaField = 'meta',
    descField = 'desc',
    emptyText = 'Контент не найден.',
  } = options;

  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return [emptyText];
  }

  const lines = [];
  list.forEach((item, index) => {
    const title = item && item[titleField] != null ? String(item[titleField]) : `Пункт ${index + 1}`;
    const href = item && item[hrefField] != null ? String(item[hrefField]) : '';
    const meta = item && item[metaField] != null ? normalizeWhitespace(item[metaField]) : '';
    const desc = item && item[descField] != null ? sanitizeMarkdown(item[descField]) : '';

    lines.push(`${index + 1}. ${formatMarkdownLink(title, href)}${meta ? ` — ${meta}` : ''}`);
    if (desc) lines.push(`   ${desc}`);
    lines.push('');
  });

  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

function parseCompactNumber(text) {
  const raw = normalizeWhitespace(text).toLowerCase();
  if (!raw) return 0;

  const match = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return 0;

  const num = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(num)) return 0;

  if (/\b(k|тыс)\b/.test(raw) || /тыс\./.test(raw)) return Math.round(num * 1_000);
  if (/\b(m|млн)\b/.test(raw) || /млн\./.test(raw)) return Math.round(num * 1_000_000);
  if (/\b(b|млрд)\b/.test(raw) || /млрд\./.test(raw)) return Math.round(num * 1_000_000_000);

  return Math.round(num);
}

module.exports = {
  normalizeWhitespace,
  sanitizeMarkdown,
  truncate,
  toAbsoluteUrl,
  uniqueBy,
  joinMeta,
  formatMarkdownLink,
  renderOrderedItems,
  parseCompactNumber,
};
