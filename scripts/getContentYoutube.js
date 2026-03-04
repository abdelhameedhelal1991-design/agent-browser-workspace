'use strict';

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sanitizeForMarkdown(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function parseCount(text) {
  const raw = String(text || '').trim();
  if (!raw) return 0;

  const s = raw
    .replace(/\u00a0/g, ' ')
    .replace(/,/g, '.')
    .toLowerCase();

  const match = s.match(/(\d+(?:\.\d+)?)/);
  if (!match) return 0;

  const num = Number(match[1]);
  if (!Number.isFinite(num)) return 0;

  if (/\b(k|тыс)\b/.test(s) || /тыс\./.test(s)) return Math.round(num * 1_000);
  if (/\b(m|млн)\b/.test(s) || /млн\./.test(s)) return Math.round(num * 1_000_000);
  if (/\b(b|млрд)\b/.test(s) || /млрд\./.test(s)) return Math.round(num * 1_000_000_000);

  return Math.round(num);
}

function decodeHtmlEntities(input) {
  const s = String(input || '');
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      if (!Number.isFinite(code)) return _;
      try { return String.fromCodePoint(code); } catch { return _; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      if (!Number.isFinite(code)) return _;
      try { return String.fromCodePoint(code); } catch { return _; }
    });
}

function isYouTubeShortsUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/shorts/');
  } catch {
    return false;
  }
}

function detectYouTubeVideoId(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  try {
    const u = new URL(raw);
    const host = (u.hostname || '').toLowerCase();

    if (host === 'youtu.be') {
      const id = u.pathname.replace(/^\/+/, '').split('/')[0];
      return id || null;
    }

    if (u.pathname.startsWith('/shorts/')) {
      const id = u.pathname.split('/')[2] || '';
      return id || null;
    }

    const v = u.searchParams.get('v');
    return v || null;
  } catch {
    return null;
  }
}

function buildUrlWithParam(baseUrl, key, value) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

async function safeQueryText(browser, selectorList) {
  const sel = String(selectorList || '').trim();
  if (!sel) return '';

  return browser.evaluate((selectorList) => {
    const selectors = String(selectorList).split(',').map(s => s.trim()).filter(Boolean);
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent) {
        const text = el.textContent.replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    }
    return '';
  }, sel);
}

async function safeClickIfExists(browser, selectorList, options = {}) {
  const sel = String(selectorList || '').trim();
  if (!sel) return false;

  const allowHidden = options && options.allowHidden === true;

  try {
    const did = await browser.evaluate(({ selectorList, allowHidden }) => {
      const selectors = String(selectorList).split(',').map(s => s.trim()).filter(Boolean);
      for (const sel of selectors) {
        try {
          const els = Array.from(document.querySelectorAll(sel));
          if (els.length === 0) continue;
          for (const el of els) {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
            const visible = style
              && style.display !== 'none'
              && style.visibility !== 'hidden'
              && rect
              && rect.width > 0
              && rect.height > 0;
            if (!visible) continue;
            el.click();
            return true;
          }
          if (allowHidden) {
            try {
              els[0].click();
              return true;
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore selector errors
        }
      }
      return false;
    }, { selectorList: sel, allowHidden });
    return !!did;
  } catch {
    return false;
  }
}

function chooseCaptionTrack(tracks, { preferManual = true } = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;

  const ranked = [...tracks].sort((a, b) => {
    const aAuto = a.isAsr ? 1 : 0;
    const bAuto = b.isAsr ? 1 : 0;
    if (preferManual && aAuto !== bAuto) return aAuto - bAuto;

    const aRu = String(a.languageCode || '').startsWith('ru') ? 0 : 1;
    const bRu = String(b.languageCode || '').startsWith('ru') ? 0 : 1;
    if (aRu !== bRu) return aRu - bRu;

    const aEn = String(a.languageCode || '').startsWith('en') ? 0 : 1;
    const bEn = String(b.languageCode || '').startsWith('en') ? 0 : 1;
    if (aEn !== bEn) return aEn - bEn;

    return 0;
  });

  return ranked[0] || null;
}

async function getCaptionTracks(browser) {
  return browser.evaluate(() => {
    const pr = (window.ytInitialPlayerResponse)
      || (typeof ytInitialPlayerResponse !== 'undefined' ? ytInitialPlayerResponse : null);
    const captionTracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    const toName = (name) => {
      if (!name) return '';
      if (name.simpleText) return String(name.simpleText);
      if (Array.isArray(name.runs)) return name.runs.map(r => r.text).join('');
      return '';
    };

    return captionTracks.map(t => ({
      languageCode: t.languageCode || '',
      name: toName(t.name),
      baseUrl: t.baseUrl || '',
      kind: t.kind || '',
      isAsr: t.kind === 'asr',
    })).filter(t => t.baseUrl);
  });
}

async function fetchTimedtextTranscript(browser, track) {
  if (!browser.page || !track || !track.baseUrl) return { ok: false, reason: 'no_track' };

  // 1) json3
  try {
    const urlJson3 = buildUrlWithParam(track.baseUrl, 'fmt', 'json3');
    const resp = await browser.page.request.get(urlJson3);
    const body = await resp.body();
    if (resp.ok() && body.length > 0) {
      const txt = body.toString('utf8');
      try {
        const json = JSON.parse(txt);
        const parts = [];
        for (const ev of (json.events || [])) {
          if (!ev || !Array.isArray(ev.segs)) continue;
          const segText = ev.segs.map(s => s.utf8 || '').join('');
          if (segText) parts.push(segText);
        }
        const transcript = normalizeWhitespace(parts.join(' '));
        if (transcript) {
          return { ok: true, transcript, source: 'timedtext:json3' };
        }
      } catch {
        // continue
      }
    }
  } catch {
    // continue
  }

  // 2) xml-ish
  try {
    const resp = await browser.page.request.get(track.baseUrl);
    const body = await resp.body();
    if (resp.ok() && body.length > 0) {
      const raw = body.toString('utf8');
      const matches = [...raw.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)];
      const parts = matches.map(m => decodeHtmlEntities(m[1]));
      const transcript = normalizeWhitespace(parts.join(' '));
      if (transcript) {
        return { ok: true, transcript, source: 'timedtext:xml' };
      }
    }
  } catch {
    // continue
  }

  return { ok: false, reason: 'timedtext_empty_or_blocked' };
}

async function fetchInnertubeTranscript(browser, pageUrl) {
  if (!browser.page) return { ok: false, reason: 'no_page' };

  try {
    const requestPayload = await browser.evaluate(() => {
      const g = (k) => (window.ytcfg && window.ytcfg.get) ? window.ytcfg.get(k) : null;

      const ctx = g('INNERTUBE_CONTEXT');
      const apiKey = g('INNERTUBE_API_KEY');
      const clientName = g('INNERTUBE_CONTEXT_CLIENT_NAME') || 1;
      const clientVersion = g('INNERTUBE_CLIENT_VERSION') || (ctx && ctx.client ? ctx.client.clientVersion : '');
      const visitor = g('VISITOR_DATA') || (ctx && ctx.client ? ctx.client.visitorData : '');
      const pageCl = g('PAGE_CL');
      const pageLabel = g('PAGE_BUILD_LABEL');
      const authUser = g('SESSION_INDEX') || '0';
      const idToken = g('ID_TOKEN') || '';

      const yt = window.ytInitialData || (typeof ytInitialData !== 'undefined' ? ytInitialData : null);
      const panels = yt?.engagementPanels || [];
      const panel = panels.find(p => {
        const r = p.engagementPanelSectionListRenderer;
        const id = (r && (r.panelIdentifier || r.targetId)) || '';
        return String(id).toLowerCase().includes('transcript');
      });

      const ep = panel?.engagementPanelSectionListRenderer?.content?.continuationItemRenderer?.continuationEndpoint;
      const params = ep?.getTranscriptEndpoint?.params || '';

      return { ctx, apiKey, clientName, clientVersion, visitor, pageCl, pageLabel, authUser, idToken, params };
    });

    if (!requestPayload || !requestPayload.apiKey || !requestPayload.ctx || !requestPayload.params) {
      return { ok: false, reason: 'missing_innertube_context_or_params' };
    }

    const apiUrl = `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(requestPayload.apiKey)}`;
    let paramsDecoded = String(requestPayload.params);
    try { paramsDecoded = decodeURIComponent(paramsDecoded); } catch { /* keep as-is */ }

    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json',
      'origin': 'https://www.youtube.com',
      'referer': pageUrl,
      'x-youtube-client-name': String(requestPayload.clientName || 1),
      'x-youtube-client-version': String(requestPayload.clientVersion || ''),
      'x-goog-visitor-id': String(requestPayload.visitor || ''),
      'x-youtube-page-cl': String(requestPayload.pageCl || ''),
      'x-youtube-page-label': String(requestPayload.pageLabel || ''),
      'x-goog-authuser': String(requestPayload.authUser || '0'),
    };
    if (requestPayload.idToken) headers['x-youtube-identity-token'] = String(requestPayload.idToken);

    const body = {
      context: requestPayload.ctx,
      params: paramsDecoded,
      contentCheckOk: true,
      racyCheckOk: true,
    };

    const resp = await browser.page.request.post(apiUrl, { headers, data: body });
    const status = resp.status();
    const txt = await resp.text();

    if (!resp.ok()) {
      return { ok: false, reason: `youtubei_http_${status}`, details: txt.slice(0, 400) };
    }

    let json;
    try { json = JSON.parse(txt); } catch { return { ok: false, reason: 'youtubei_non_json' }; }

    const segments = [];
    const stack = [json];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (Array.isArray(cur)) {
        for (const it of cur) stack.push(it);
        continue;
      }
      if (cur.transcriptSegmentRenderer) {
        const r = cur.transcriptSegmentRenderer;
        const runs = r.snippet?.runs;
        const simple = r.snippet?.simpleText;
        const txtSeg = Array.isArray(runs)
          ? runs.map(x => x.text || '').join('')
          : (typeof simple === 'string' ? simple : '');
        const cleaned = normalizeWhitespace(txtSeg);
        if (cleaned) segments.push(cleaned);
      }
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }

    const transcript = normalizeWhitespace(segments.join(' '));
    if (!transcript) return { ok: false, reason: 'youtubei_empty_transcript' };

    return { ok: true, transcript, source: 'youtubei:get_transcript' };
  } catch (err) {
    return { ok: false, reason: 'youtubei_exception', details: err && err.message ? err.message : String(err) };
  }
}

async function fetchUiTranscript(browser, selectors, timeoutMs) {
  const metaSel = String(selectors.watchMetadata || '').trim();
  const openBtnSel = String(selectors.transcriptOpenButton || '').trim();
  const segSel = String(selectors.transcriptSegment || '').trim();
  const scrollSel = String(selectors.transcriptScrollContainer || '').trim();

  if (!openBtnSel || !segSel) return { ok: false, reason: 'missing_ui_selectors' };

  // Give YouTube time to hydrate the watch page UI before searching for buttons.
  try {
    await browser.page.waitForSelector(metaSel || 'ytd-watch-metadata', { state: 'attached', timeout: timeoutMs || 15000 });
  } catch { /* best-effort */ }
  try {
    await browser.page.waitForSelector(openBtnSel, { state: 'attached', timeout: timeoutMs || 15000 });
  } catch { /* proceed to best-effort click */ }

  const clicked = await safeClickIfExists(browser, openBtnSel, { allowHidden: true });
  if (!clicked) return { ok: false, reason: 'transcript_open_button_not_found' };

  try {
    await browser.page.waitForSelector(segSel, { state: 'attached', timeout: timeoutMs || 15000 });
  } catch {
    return { ok: false, reason: 'transcript_segments_not_loaded' };
  }

  // Try to scroll transcript container to load more segments (best-effort).
  if (scrollSel) {
    try {
      await browser.evaluate(async ({ scrollSel, segSel }) => {
        const pick = (list) => {
          const selectors = String(list).split(',').map(s => s.trim()).filter(Boolean);
          for (const sel of selectors) {
            try {
              const el = document.querySelector(sel);
              if (el) return el;
            } catch { /* ignore */ }
          }
          return null;
        };
        const container = pick(scrollSel) || document.scrollingElement;
        if (!container) return;

        let lastCount = document.querySelectorAll(segSel).length;
        for (let i = 0; i < 8; i++) {
          try { container.scrollTop = container.scrollHeight; } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 600));
          const current = document.querySelectorAll(segSel).length;
          if (current <= lastCount) break;
          lastCount = current;
        }
      }, { scrollSel, segSel });
    } catch {
      // ignore
    }
  }

  const segments = await browser.evaluate((segSel) => {
    const els = Array.from(document.querySelectorAll(segSel));
    const stripTs = (s) => s.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, '');
    return els
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map(stripTs)
      .filter(Boolean);
  }, segSel);

  const transcript = normalizeWhitespace(segments.join(' '));
  if (!transcript) return { ok: false, reason: 'ui_empty_transcript' };

  return { ok: true, transcript, source: 'ui:transcript' };
}

async function extractTopComments(browser, selectors, ytCfg) {
  const sectionSel = String(selectors.commentsSection || '').trim();
  const threadSel = String(selectors.commentThread || '').trim();
  if (!sectionSel || !threadSel) return [];

  try {
    await browser.scroll({ selector: sectionSel });
    await browser.wait(1000);

    // Prefer "Top comments" sorting.
    if (ytCfg.setCommentsSortToTop !== false && selectors.commentsSortMenuButton) {
      const clicked = await safeClickIfExists(browser, selectors.commentsSortMenuButton);
      if (clicked) {
        await browser.wait(300);
        await browser.evaluate((itemsSelector) => {
          const candidates = [/top comments/i, /популяр/i, /best/i];
          const items = Array.from(document.querySelectorAll(itemsSelector));
          const pick = items.find(el => {
            const t = (el.textContent || '').trim();
            return candidates.some(re => re.test(t));
          });
          if (pick) pick.click();
        }, selectors.commentsSortMenuItems || 'tp-yt-paper-listbox tp-yt-paper-item');
        await browser.wait(800);
      }
    }

    // Load a few screens of comment threads
    await browser.scroll({ times: 3, delay: 1200, timeout: 20000 });

    const extracted = await browser.evaluate((s) => {
      const threads = Array.from(document.querySelectorAll(s.commentThread || 'ytd-comment-thread-renderer'));
      const out = [];
      for (const t of threads.slice(0, 60)) {
        const getText = (sel) => {
          const el = sel ? t.querySelector(sel) : null;
          return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
        };
        out.push({
          author: getText(s.commentAuthor),
          text: getText(s.commentText),
          publishedTime: getText(s.commentPublishedTime),
          likeText: getText(s.commentLikeCount),
        });
      }
      return out;
    }, selectors);

    const max = Number.isFinite(ytCfg.maxTopComments) ? ytCfg.maxTopComments : 10;
    return extracted
      .map(c => ({
        author: c.author || '',
        text: c.text || '',
        publishedTime: c.publishedTime || '',
        likeText: c.likeText || '',
        likeCount: parseCount(c.likeText),
      }))
      .filter(c => c.text)
      .sort((a, b) => (b.likeCount - a.likeCount))
      .slice(0, Math.max(0, max))
      .map(({ likeCount, ...rest }) => rest);
  } catch {
    return [];
  }
}

/**
 * Extract YouTube-specific structured content (title, description, transcript, top comments).
 *
 * @param {object} args
 * @param {import('../utils/browserUse')} args.browser
 * @param {string} args.pageUrl
 * @param {object} args.profile  Site profile from scripts/sites/youtube.json
 * @param {number} [args.timeoutMs]
 * @returns {Promise<null|{youtube: object, markdown: string}>}
 */
async function getContentYoutube({ browser, pageUrl, profile, timeoutMs }) {
  if (!browser || !browser.page || !pageUrl || !profile) return null;

  const selectors = profile?.scraping?.selectors || {};
  const ytCfg = profile?.scraping?.youtube || {};

  const isShorts = isYouTubeShortsUrl(pageUrl);
  const videoId = detectYouTubeVideoId(pageUrl);

  if (isShorts) {
    return { youtube: { isShorts: true, videoId, url: pageUrl }, markdown: '' };
  }

  // Title
  let title = normalizeWhitespace(await safeQueryText(browser, selectors.videoTitle));
  if (!title) {
    try {
      title = normalizeWhitespace(await browser.evaluate(() => {
        const pr = (window.ytInitialPlayerResponse)
          || (typeof ytInitialPlayerResponse !== 'undefined' ? ytInitialPlayerResponse : null);
        return pr?.videoDetails?.title || '';
      }));
    } catch { /* ignore */ }
  }

  // Description
  let description = '';
  if (ytCfg.expandDescription !== false) {
    await safeClickIfExists(browser, selectors.descriptionExpandButton);
    description = sanitizeForMarkdown(await safeQueryText(browser, selectors.descriptionText));
  }
  if (!description) {
    try {
      description = sanitizeForMarkdown(await browser.evaluate(() => {
        const pr = (window.ytInitialPlayerResponse)
          || (typeof ytInitialPlayerResponse !== 'undefined' ? ytInitialPlayerResponse : null);
        return pr?.videoDetails?.shortDescription || '';
      }));
    } catch { /* ignore */ }
  }

  // Transcript (fallback chain)
  let transcript = '';
  let transcriptLanguage = '';
  let transcriptSource = '';
  let transcriptError = '';

  const tracks = await getCaptionTracks(browser);
  const preferManual = ytCfg.preferManualCaptions !== false;
  const chosen = chooseCaptionTrack(tracks, { preferManual });
  if (chosen) transcriptLanguage = chosen.languageCode || '';

  const timedtext = await fetchTimedtextTranscript(browser, chosen);
  if (timedtext.ok) {
    transcript = timedtext.transcript;
    transcriptSource = timedtext.source;
  } else {
    const innertube = await fetchInnertubeTranscript(browser, pageUrl);
    if (innertube.ok) {
      transcript = innertube.transcript;
      transcriptSource = innertube.source;
    } else {
      const ui = await fetchUiTranscript(browser, selectors, timeoutMs || 15000);
      if (ui.ok) {
        transcript = ui.transcript;
        transcriptSource = ui.source;
      } else {
        transcriptError = innertube.reason
          ? `innertube: ${innertube.reason}; timedtext: ${timedtext.reason}; ui: ${ui.reason}`
          : `timedtext: ${timedtext.reason}; ui: ${ui.reason}`;
      }
    }
  }

  // Comments
  const comments = await extractTopComments(browser, selectors, ytCfg);

  const youtube = {
    isShorts,
    videoId,
    url: pageUrl,
    title,
    description,
    transcript,
    transcriptLanguage,
    transcriptSource,
    ...(transcriptError ? { transcriptError } : {}),
    comments,
  };

  const hasAny = !!(title || description || transcript || (comments && comments.length > 0));
  if (!hasAny) return null;

  const md = [];
  md.push('## YouTube');
  md.push('');
  md.push(`- **URL**: ${youtube.url}`);
  if (youtube.videoId) md.push(`- **Video ID**: \`${youtube.videoId}\``);
  if (youtube.title) md.push(`- **Название**: ${youtube.title}`);
  if (youtube.transcriptLanguage) {
    const suffix = youtube.transcript
      ? (youtube.transcriptSource ? ` (${youtube.transcriptSource})` : '')
      : (youtube.transcriptError ? ' (не удалось извлечь текст)' : '');
    md.push(`- **Субтитры**: ${youtube.transcriptLanguage}${suffix}`);
  }

  if (youtube.description) {
    md.push('');
    md.push('### Описание');
    md.push('');
    md.push(youtube.description);
  }

  if (youtube.transcript) {
    md.push('');
    md.push('### Субтитры / транскрипт');
    md.push('');
    md.push(youtube.transcript);
  }

  if (youtube.comments && youtube.comments.length > 0) {
    md.push('');
    md.push(`### Топ комментарии (до ${youtube.comments.length})`);
    md.push('');
    youtube.comments.forEach((c, i) => {
      const parts = [];
      if (c.author) parts.push(c.author);
      if (c.likeText) parts.push(`👍 ${c.likeText}`);
      if (c.publishedTime) parts.push(c.publishedTime);
      const meta = parts.length ? ` — ${parts.join(' · ')}` : '';
      md.push(`${i + 1}. ${c.text}${meta}`);
    });
  }

  return { youtube, markdown: md.join('\n') };
}

module.exports = getContentYoutube;
module.exports.getContentYoutube = getContentYoutube;
