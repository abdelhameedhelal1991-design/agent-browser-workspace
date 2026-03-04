'use strict';

const cheerio = require('cheerio');
const TurndownService = require('turndown');
const fs = require('fs');
const path = require('path');

// ============================================================
//  CONFIGURATION
// ============================================================

const THRESHOLDS = {
  MIN_EXTRACTED_SIZE: 250,
  MIN_CONTENT_WORDS: 30,
  LINK_DENSITY_NAV: 0.5,
  LINK_DENSITY_CONTENT_MAX: 0.33,
  MIN_NAV_LINKS: 3,
  SCORING_POSITIVE: 25,
  SCORING_NEGATIVE: -25,
  SIBLING_SCORE_RATIO: 0.2,
  SHORT_LINK_MAX_WORDS: 4,
};

const JUNK_TAG_SELECTORS = [
  'script', 'style', 'noscript', 'link[rel="stylesheet"]',
  'iframe', 'object', 'embed', 'applet',
  'audio', 'video', 'canvas', 'svg', 'map', 'area',
  'input', 'select', 'textarea', 'button',
  'datalist', 'dialog', 'fieldset', 'label', 'legend',
  'marquee', 'math', 'menuitem', 'optgroup', 'option',
  'output', 'param', 'progress', 'source', 'track',
].join(', ');

const NAV_TIERS = [
  {
    tier: 1,
    selectors: ['nav', '[role="navigation"]', '[role="menubar"]'],
  },
  {
    tier: 2,
    selectors: [
      '.nav', '.navigation', '.menu', '.main-menu', '.primary-menu',
      '.navbar', '.nav-bar', '.main-nav', '.site-nav', '.top-nav',
      '.topnav', '.sidebar-nav', '.subnav', '.mobile-menu',
      '.hamburger-menu', '.dropdown-menu',
    ],
  },
  {
    tier: 3,
    selectors: [
      '#nav', '#navigation', '#menu', '#main-menu', '#main-nav', '#topnav',
    ],
  },
];

const CONTENT_TIERS = [
  {
    tier: 1,
    selectors: ['main', '[role="main"]'],
  },
  {
    tier: 2,
    selectors: ['article'],
  },
  {
    tier: 3,
    selectors: ['[itemprop="articleBody"]', '[itemprop="mainEntity"]'],
  },
  {
    tier: 4,
    selectors: [
      '.content', '.main-content', '.article', '.post-content',
      '.entry-content', '.story-body', '.article-body',
      '.page-content', '.article-text', '.post-body',
      '.post-text', '.post_text', '.post-entry', '.postentry',
      '.postcontent', '.postContent', '.blog-content',
      '.text-content', '.body-text', '.art-content',
      '.theme-content', '.section-content', '.single-content',
      '.single-post', '.storycontent', '.story-content',
      '.wpb_text_column', '.field-body', '.fulltext',
    ],
  },
  {
    tier: 5,
    selectors: [
      '#content', '#main-content', '#main', '#article',
      '#post-content', '#story-body', '#primary', '#story',
    ],
  },
];

const NOISE_WITHIN_CONTENT = [
  '.social', '.share', '.sharing', '.share-buttons',
  '.ad', '.ads', '.advertisement', '.ad-container',
  '.widget', '.widget-area',
  '.sidebar', '.sidebar-widget',
  '.related', '.related-posts', '.related-articles',
  '.comments', '.comment-section', '.comment-list',
  '.newsletter', '.subscribe',
  '.cookie', '.cookie-banner', '.consent',
  '.popup', '.modal', '.overlay',
  '.promo', '.promotion', '.sponsor',
  '.author-bio', '.author-info',
  '.tags', '.tag-list', '.post-tags',
  '.rating', '.ratings',
  '[role="complementary"]',
].join(', ');

const PATTERNS = {
  navClassId: /(?:^|\s|[-_])(nav|navbar|navigation|menu|main-menu|primary-menu|site-nav|top-nav|topnav|main-nav|sidebar-nav|subnav|mobile-menu|hamburger|dropdown-menu)(?:$|\s|[-_])/i,

  contentClassId: /(?:^|\s|[-_])(content|main-content|article|post-content|entry-content|story-body|article-body|page-content|article-text|post-body|post-text|blog-content|text-content|body-text|art-content|single-post|single-content|fulltext|field-body)(?:$|\s|[-_])/i,

  noiseClassId: /(?:^|\s|[-_])(sidebar|widget|ad-break|ads?|advertisement|banner|promo|sponsor|social|share|sharing|related|comments?|cookie|consent|popup|modal|overlay|outbrain|taboola|criteo|paid-content|paidcontent|newsletter|tag-list|shoutbox|rss|disqus)(?:$|\s|[-_])/i,

  positive: /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
  negative: /hidden|hid|banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget/i,

  unlikely: /-ad-|ai2html|banner|breadcrumbs?|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
  maybeCandidate: /and|article|body|column|content|main|shadow/i,

  breadcrumb: /(?:^|\s|[-_])(breadcrumb|bread-crumb|BreadcrumbList)(?:$|\s|[-_])/i,
  toc: /(?:^|\s|[-_])(toc|table-of-contents|tableofcontents)(?:$|\s|[-_])/i,
  pagination: /(?:^|\s|[-_])(pagination|pager|page-numbers|page-nav)(?:$|\s|[-_])/i,
  commentSection: /(?:^|\s|[-_])(comment-?list|comment-page|comments?-content|post-comments|disqus_thread|dsq-comments)(?:$|\s|[-_])/i,
  hidden: /display\s*:\s*none|visibility\s*:\s*hidden/i,
};

const FORM_TIERS = [
  {
    tier: 1,
    selectors: ['form', '[role="search"]', '[role="form"]'],
  },
  {
    tier: 2,
    selectors: [
      '.login-form', '.signin-form', '.auth-form', '.signup-form', '.register-form',
      '.login', '.signin', '.sign-in', '.log-in', '.auth', '.registration',
      '#login', '#signin', '#auth', '#register', '#signup',
      '#login-form', '#signin-form', '#auth-form', '#signup-form',
      '.search-form', '.search-box', '.search-bar', '.site-search', '.search-panel',
      '.header-search', '.global-search', '.quick-search', '.searchbox',
      '#search', '#search-form', '#searchbox', '#site-search',
      '.filter-form', '.filters', '.facets', '.facet', '.filter-panel',
      '.sort-form', '.sorting', '.refinements', '.catalog-filter', '.product-filter',
      '#filter', '#filters', '#sort', '#filter-form',
      '.contact-form', '.feedback-form', '.support-form',
      '#contact-form', '#feedback-form',
      '.subscribe-form', '.newsletter-form', '.subscription-form', '.optin-form',
      '#subscribe', '#newsletter', '#subscribe-form',
    ],
  },
];

const FORM_PATTERNS = {
  formClassId: /(?:^|\s|[-_])(login|log-in|signin|sign-in|auth|authentication|authorize|register|signup|sign-up|registration|password|forgot-password|recover|create-account|search|search-form|search-box|searchbox|filter|filters|facet|facets|sort|sorting|sort-by|refinement|refine|contact|feedback|enquiry|inquiry|subscribe|subscription|newsletter|optin|opt-in|mailing-list|email-signup)(?:$|\s|[-_])/i,

  auth: /(?:^|\s|[-_])(login|log-in|signin|sign-in|auth|authentication|authorize|register|signup|sign-up|registration|password-reset|forgot-password|recover-password|create-account)(?:$|\s|[-_])/i,
  search: /(?:^|\s|[-_])(search|site-search|search-form|search-box|searchbox|search-bar|search-panel|quick-search|global-search|header-search)(?:$|\s|[-_])/i,
  filter: /(?:^|\s|[-_])(filter|filters|facet|facets|faceted|sort|sorting|sort-by|sort-options|refinement|refine|catalog-filter|product-filter|sidebar-filter|filter-panel|filter-bar|advanced-filter)(?:$|\s|[-_])/i,
  contact: /(?:^|\s|[-_])(contact|contact-form|feedback|feedback-form|enquiry|inquiry|get-in-touch|message-form|write-us|support-form)(?:$|\s|[-_])/i,
  subscribe: /(?:^|\s|[-_])(subscribe|subscription|newsletter|mailing-list|email-signup|optin|opt-in|newsletter-form)(?:$|\s|[-_])/i,
};

const TAG_BASE_SCORES = {
  div: 5, article: 5,
  pre: 3, td: 3, blockquote: 3,
  address: -3, ol: -3, ul: -3, dl: -3, dd: -3, dt: -3, li: -3, form: -3, aside: -3,
  h1: -5, h2: -5, h3: -5, h4: -5, h5: -5, h6: -5,
  th: -5, header: -5, footer: -5, nav: -5,
};

const TIER_CONFIDENCE = { 1: 0.95, 2: 0.90, 3: 0.85, 4: 0.80, 5: 0.75, 6: 0.65 };

const TURNDOWN_OPTIONS = {
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '_',
  strongDelimiter: '**',
  linkStyle: 'inlined',
  linkReferenceStyle: 'full',
};

function createTurndownService() {
  return new TurndownService(TURNDOWN_OPTIONS);
}


// ============================================================
//  DOM UTILITIES
// ============================================================

function getClassId(el, $) {
  const cls = $(el).attr('class') || '';
  const id = $(el).attr('id') || '';
  return (cls + ' ' + id).trim();
}

function textLen(el, $) {
  return ($(el).text() || '').replace(/\s+/g, ' ').trim().length;
}

function wordCount(el, $) {
  const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
  if (!text) return 0;
  return text.split(/\s+/).length;
}

function linkTextLen(el, $) {
  let total = 0;
  $(el).find('a').each((_, a) => {
    total += ($(a).text() || '').replace(/\s+/g, ' ').trim().length;
  });
  return total;
}

function linkDensity(el, $) {
  const total = textLen(el, $);
  if (total === 0) return 0;
  return linkTextLen(el, $) / total;
}

function linkCount(el, $) {
  return $(el).find('a').length;
}

function tagCount(el, $) {
  return $(el).find('*').length || 1;
}

function ttr(el, $) {
  return textLen(el, $) / tagCount(el, $);
}

function headingCount(el, $) {
  return $(el).find('h1, h2, h3, h4, h5, h6').length;
}

function paragraphCount(el, $) {
  return $(el).find('p').length;
}

function listItemCount(el, $) {
  return $(el).find('li').length;
}

function commaCount(el, $) {
  return (($(el).text() || '').match(/[,，、]/g) || []).length;
}

function tagName(el, $) {
  return ($(el).prop('tagName') || $(el).prop('name') || '').toLowerCase();
}

function outerHtml(el, $) {
  return $.html($(el));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isAncestorOf($, ancestor, descendant) {
  return $(descendant).parents().is($(ancestor));
}

function hasAncestorInSet(el, $, nodeSet) {
  let current = $(el).parent();
  while (current.length && current[0] && current[0].type !== 'root') {
    if (nodeSet.has(current[0])) return true;
    current = current.parent();
  }
  return false;
}

function containsNodeFromSet(el, $, nodeSet) {
  for (const node of nodeSet) {
    if (isAncestorOf($, el, node)) return true;
  }
  return false;
}

function computeFeatures(el, $) {
  const tl = textLen(el, $);
  const wc = wordCount(el, $);
  const ld = linkDensity(el, $);
  const lc = linkCount(el, $);
  const hc = headingCount(el, $);
  const pc = paragraphCount(el, $);
  const lic = listItemCount(el, $);
  const textToTag = ttr(el, $);

  return {
    textLength: tl,
    wordCount: wc,
    linkDensity: Math.round(ld * 1000) / 1000,
    linkCount: lc,
    headingCount: hc,
    paragraphCount: pc,
    listItemCount: lic,
    ttr: Math.round(textToTag * 100) / 100,
  };
}


// ============================================================
//  METADATA EXTRACTION
// ============================================================

function extractMetadata($) {
  const metadata = {
    title: $('title').first().text().trim(),
    lang: $('html').attr('lang') || $('html').attr('xml:lang') || '',
    description: $('meta[name="description"]').attr('content') || '',
    jsonLd: null,
    jsonLdContent: null,
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = JSON.parse($(el).text());
      const items = Array.isArray(raw) ? raw : [raw];

      for (const item of items) {
        const entities = item['@graph'] ? item['@graph'] : [item];
        for (const entity of entities) {
          if (entity.articleBody) {
            metadata.jsonLdContent = entity.articleBody;
          }
          const type = entity['@type'];
          const articleTypes = ['Article', 'NewsArticle', 'BlogPosting', 'WebPage', 'TechArticle', 'Report'];
          if (articleTypes.includes(type)) {
            metadata.jsonLd = entity;
            if (entity.articleBody) {
              metadata.jsonLdContent = entity.articleBody;
            }
          }
          if (!metadata.jsonLd && entity['@type']) {
            metadata.jsonLd = entity;
          }
        }
      }
    } catch (_e) { /* invalid JSON-LD */ }
  });

  return metadata;
}


// ============================================================
//  NOISE REMOVAL
// ============================================================

function removeJunk($) {
  $(JUNK_TAG_SELECTORS).remove();

  $('[style]').each((_, el) => {
    if (PATTERNS.hidden.test($(el).attr('style') || '')) {
      $(el).remove();
    }
  });

  $('[hidden]').remove();

  $('[aria-hidden="true"]').each((_, el) => {
    const isInsideContent = $(el).closest('main, article, [role="main"]').length > 0;
    if (!isInsideContent) {
      $(el).remove();
    }
  });

  $('*').contents().filter(function () {
    return this.type === 'comment';
  }).remove();

  const emptyTags = [
    'div', 'p', 'span', 'section', 'b', 'em', 'i', 'strong',
    'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  ];
  for (let pass = 0; pass < 2; pass++) {
    for (const tag of emptyTags) {
      $(tag).each((_, el) => {
        if (!$(el).text().trim() && !$(el).find('img, picture, table').length) {
          $(el).remove();
        }
      });
    }
  }
}


// ============================================================
//  FORM DETECTION (3-Tier Cascade)
//  Runs BEFORE removeJunk — inputs/selects/buttons still in DOM
// ============================================================

function findFormBlocks($) {
  const blocks = [];
  const nodeSet = new Set();

  for (const group of FORM_TIERS) {
    for (const sel of group.selectors) {
      $(sel).each((_, el) => {
        if (nodeSet.has(el)) return;
        if (hasAncestorInSet(el, $, nodeSet)) return;
        if (!hasFormControls(el, $)) return;

        nodeSet.add(el);
        blocks.push(buildFormBlock(el, $, group.tier, sel));
      });
    }
  }

  collectRegexForms($, blocks, nodeSet);
  collectStructuralForms($, blocks, nodeSet);

  return blocks;
}

function collectRegexForms($, blocks, nodeSet) {
  $('div, section, aside, header, footer, fieldset').each((_, el) => {
    if (nodeSet.has(el)) return;
    if (hasAncestorInSet(el, $, nodeSet)) return;
    if (containsNodeFromSet(el, $, nodeSet)) return;

    const classId = getClassId(el, $);
    if (!classId) return;
    if (!FORM_PATTERNS.formClassId.test(classId)) return;
    if (!hasFormControls(el, $)) return;

    nodeSet.add(el);
    blocks.push(buildFormBlock(el, $, 3, `regex:${classId.substring(0, 40)}`));
  });
}

function collectStructuralForms($, blocks, nodeSet) {
  const visited = new Set();

  $('input:not([type="hidden"]), select, textarea').each((_, input) => {
    if ($(input).closest('form').length) return;
    if (hasAncestorInSet(input, $, nodeSet)) return;

    const container = findFormContainer(input, $, nodeSet);
    if (!container || visited.has(container) || nodeSet.has(container)) return;
    if (hasAncestorInSet(container, $, nodeSet)) return;
    if (containsNodeFromSet(container, $, nodeSet)) return;

    visited.add(container);
    nodeSet.add(container);
    blocks.push(buildFormBlock(container, $, 4, 'structural'));
  });
}

function findFormContainer(input, $, nodeSet) {
  const containerTags = new Set(['div', 'section', 'aside', 'header', 'footer', 'fieldset', 'li', 'td', 'th']);
  let el = $(input).parent();

  while (el.length && el[0] && el[0].type !== 'root') {
    const tag = tagName(el[0], $);
    if (containerTags.has(tag)) {
      const visibleInputs = el.find('input:not([type="hidden"]), select, textarea');
      const buttons = el.find('button, input[type="submit"], input[type="button"], [type="image"], [role="button"]');

      if (visibleInputs.length >= 2 || (visibleInputs.length >= 1 && buttons.length >= 1)) {
        const allDescendants = el.find('*').length;
        if (allDescendants < 150 || (visibleInputs.length + buttons.length) / allDescendants > 0.02) {
          return el[0];
        }
      }
    }
    el = el.parent();
  }
  return null;
}

function hasFormControls(el, $) {
  return $(el).find('input:not([type="hidden"]), select, textarea').length > 0;
}

function classifyFormType(el, $) {
  const classId = getClassId(el, $);
  const parentClassId = getClassId($(el).parent()[0], $);
  const combined = classId + ' ' + parentClassId;
  const ariaLabel = ($(el).attr('aria-label') || '').toLowerCase();
  const role = $(el).attr('role') || '';
  const action = ($(el).attr('action') || '').toLowerCase();

  if (role === 'search') return 'search';

  if (FORM_PATTERNS.auth.test(combined) || FORM_PATTERNS.auth.test(ariaLabel)) return 'auth';
  if (FORM_PATTERNS.search.test(combined) || FORM_PATTERNS.search.test(ariaLabel)) return 'search';
  if (FORM_PATTERNS.filter.test(combined) || FORM_PATTERNS.filter.test(ariaLabel)) return 'filter';
  if (FORM_PATTERNS.contact.test(combined) || FORM_PATTERNS.contact.test(ariaLabel)) return 'contact';
  if (FORM_PATTERNS.subscribe.test(combined) || FORM_PATTERNS.subscribe.test(ariaLabel)) return 'subscribe';

  if (/login|signin|sign-in|auth/i.test(action)) return 'auth';
  if (/search|find|query/i.test(action)) return 'search';
  if (/filter|sort|refine/i.test(action)) return 'filter';
  if (/contact|feedback|enquiry/i.test(action)) return 'contact';
  if (/subscribe|newsletter|optin/i.test(action)) return 'subscribe';

  const hasPassword = $(el).find('input[type="password"]').length > 0;
  const hasSearch = $(el).find('input[type="search"]').length > 0;
  const hasEmail = $(el).find('input[type="email"]').length > 0;
  const hasTextarea = $(el).find('textarea').length > 0;
  const selectCount = $(el).find('select').length;
  const checkboxCount = $(el).find('input[type="checkbox"]').length;
  const radioCount = $(el).find('input[type="radio"]').length;

  if (hasPassword) return 'auth';
  if (hasSearch) return 'search';
  if (selectCount >= 2 || checkboxCount >= 3 || radioCount >= 3) return 'filter';
  if (hasTextarea && hasEmail) return 'contact';
  if (hasTextarea && !hasEmail) return 'contact';
  if (hasEmail && !hasPassword && !hasTextarea) return 'subscribe';

  const visibleInputs = $(el).find('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])');
  if (visibleInputs.length === 1) {
    const ph = (visibleInputs.first().attr('placeholder') || '').toLowerCase();
    const name = (visibleInputs.first().attr('name') || '').toLowerCase();
    if (/search|поиск|найти|искать|find|query|suche|chercher|buscar/i.test(ph + ' ' + name)) return 'search';
  }

  return 'generic';
}

function computeFormFeatures(el, $) {
  return {
    inputCount: $(el).find('input:not([type="hidden"])').length,
    selectCount: $(el).find('select').length,
    textareaCount: $(el).find('textarea').length,
    buttonCount: $(el).find('button, input[type="submit"], input[type="button"]').length,
    checkboxCount: $(el).find('input[type="checkbox"]').length,
    radioCount: $(el).find('input[type="radio"]').length,
    hasPasswordInput: $(el).find('input[type="password"]').length > 0,
    hasSearchInput: $(el).find('input[type="search"]').length > 0,
    hasEmailInput: $(el).find('input[type="email"]').length > 0,
    hasFileInput: $(el).find('input[type="file"]').length > 0,
    hasSubmitButton: $(el).find('input[type="submit"], button[type="submit"], button:not([type])').length > 0,
    labelCount: $(el).find('label').length,
    isWrappedInForm: tagName(el, $) === 'form',
    action: $(el).attr('action') || '',
    method: ($(el).attr('method') || '').toUpperCase(),
  };
}

function buildFormBlock(el, $, tier, selector) {
  const formType = classifyFormType(el, $);
  const evidence = [];
  const tag = tagName(el, $);
  const cssSelector = (tier <= 2 && selector && !selector.startsWith('regex:') && selector !== 'structural')
    ? selector
    : null;

  if (tag === 'form') evidence.push('tag:form');
  const role = $(el).attr('role');
  if (role) evidence.push(`role:${role}`);
  if (tier <= 2 && selector !== 'structural') evidence.push(`selector:${selector}`);
  if (tier === 3) evidence.push('regex_class_match');
  if (tier === 4) evidence.push('structural_detection');

  const features = computeFormFeatures(el, $);
  if (features.hasPasswordInput) evidence.push('has_password_input');
  if (features.hasSearchInput) evidence.push('has_search_input');
  if (features.hasEmailInput) evidence.push('has_email_input');
  if (features.hasFileInput) evidence.push('has_file_input');
  if (features.action) evidence.push(`action:${features.action}`);

  const ariaLabel = $(el).attr('aria-label');
  if (ariaLabel) evidence.push(`aria-label:${ariaLabel}`);

  return {
    node: el,
    html: outerHtml(el, $),
    tag,
    selector,
    cssSelector,
    tier,
    confidence: TIER_CONFIDENCE[tier] || 0.7,
    type: formType,
    evidence,
    features,
  };
}


// ============================================================
//  NAVIGATION DETECTION (5-Tier Cascade)
// ============================================================

function findNavigationBlocks($) {
  const blocks = [];
  const nodeSet = new Set();

  for (const group of NAV_TIERS) {
    for (const sel of group.selectors) {
      $(sel).each((_, el) => {
        if (nodeSet.has(el)) return;
        if (hasAncestorInSet(el, $, nodeSet)) return;

        const ld = linkDensity(el, $);
        const lc = linkCount(el, $);
        if (lc === 0) return;

        nodeSet.add(el);
        blocks.push({
          node: el,
          html: outerHtml(el, $),
          tag: tagName(el, $),
          selector: sel,
          cssSelector: sel,
          tier: group.tier,
          confidence: TIER_CONFIDENCE[group.tier] || 0.7,
          type: 'navigation',
          evidence: buildNavEvidence(el, $, sel, group.tier),
          features: computeFeatures(el, $),
        });
      });
    }
  }

  collectRegexNav($, blocks, nodeSet);
  collectStructuralNav($, blocks, nodeSet);
  collectStatisticalNav($, blocks, nodeSet);

  return classifyNavSubtypes(blocks, $);
}

function collectRegexNav($, blocks, nodeSet) {
  $('div, ul, ol, section, header, footer').each((_, el) => {
    if (nodeSet.has(el)) return;
    if (hasAncestorInSet(el, $, nodeSet)) return;
    if (containsNodeFromSet(el, $, nodeSet)) return;

    const classId = getClassId(el, $);
    if (!classId) return;

    if (PATTERNS.navClassId.test(classId) && !PATTERNS.contentClassId.test(classId)) {
      const lc = linkCount(el, $);
      if (lc < 2) return;

      nodeSet.add(el);
      blocks.push({
        node: el,
        html: outerHtml(el, $),
        tag: tagName(el, $),
        selector: `regex:${classId.substring(0, 40)}`,
        cssSelector: null,
        tier: 4,
        confidence: TIER_CONFIDENCE[4],
        type: 'navigation',
        evidence: buildNavEvidence(el, $, 'regex-class', 4),
        features: computeFeatures(el, $),
      });
    }
  });
}

function collectStructuralNav($, blocks, nodeSet) {
  $('header').each((_, headerEl) => {
    if (nodeSet.has(headerEl)) return;
    if (containsNodeFromSet(headerEl, $, nodeSet)) return;

    const lists = $(headerEl).find('> ul, > ol, > div > ul, > div > ol');
    lists.each((_, listEl) => {
      if (nodeSet.has(listEl)) return;
      if (hasAncestorInSet(listEl, $, nodeSet)) return;
      if (containsNodeFromSet(listEl, $, nodeSet)) return;

      const lc = linkCount(listEl, $);
      if (lc < THRESHOLDS.MIN_NAV_LINKS) return;

      const ld = linkDensity(listEl, $);
      if (ld < 0.4) return;

      nodeSet.add(listEl);
      const selector = 'header > ul, header > ol, header > div > ul, header > div > ol';
      blocks.push({
        node: listEl,
        html: outerHtml(listEl, $),
        tag: tagName(listEl, $),
        selector,
        cssSelector: selector,
        tier: 4,
        confidence: TIER_CONFIDENCE[4],
        type: 'navigation',
        evidence: ['structural:header_list', `link_density:${ld.toFixed(2)}`, `link_count:${lc}`],
        features: computeFeatures(listEl, $),
      });
    });
  });
}

function collectStatisticalNav($, blocks, nodeSet) {
  const candidates = [];

  $('div, section, ul, ol').each((_, el) => {
    if (nodeSet.has(el)) return;
    if (hasAncestorInSet(el, $, nodeSet)) return;
    if (containsNodeFromSet(el, $, nodeSet)) return;

    const ld = linkDensity(el, $);
    const lc = linkCount(el, $);
    const wc = wordCount(el, $);

    if (ld > THRESHOLDS.LINK_DENSITY_NAV && lc > THRESHOLDS.MIN_NAV_LINKS && wc > 5) {
      const avgLinkWords = computeAvgLinkWords(el, $);
      if (avgLinkWords <= THRESHOLDS.SHORT_LINK_MAX_WORDS) {
        candidates.push({ el, ld, lc, avgLinkWords });
      }
    }
  });

  candidates.sort((a, b) => b.lc - a.lc);

  for (const cand of candidates.slice(0, 5)) {
    if (nodeSet.has(cand.el)) continue;
    if (hasAncestorInSet(cand.el, $, nodeSet)) continue;
    if (containsNodeFromSet(cand.el, $, nodeSet)) continue;

    nodeSet.add(cand.el);
    blocks.push({
      node: cand.el,
      html: outerHtml(cand.el, $),
      tag: tagName(cand.el, $),
      selector: 'statistical',
      cssSelector: null,
      tier: 5,
      confidence: TIER_CONFIDENCE[5],
      type: 'navigation',
      evidence: [
        'statistical:high_link_density',
        `link_density:${cand.ld.toFixed(2)}`,
        `link_count:${cand.lc}`,
        `avg_link_words:${cand.avgLinkWords.toFixed(1)}`,
      ],
      features: computeFeatures(cand.el, $),
    });
  }
}

function computeAvgLinkWords(el, $) {
  const links = $(el).find('a');
  if (!links.length) return 0;
  let totalWords = 0;
  links.each((_, a) => {
    const text = ($(a).text() || '').replace(/\s+/g, ' ').trim();
    totalWords += text ? text.split(/\s+/).length : 0;
  });
  return totalWords / links.length;
}

function buildNavEvidence(el, $, selector, tier) {
  const evidence = [];
  const tag = tagName(el, $);

  if (tier === 1) evidence.push(`semantic:${tag}`);
  if (tier <= 3 && selector !== 'regex-class') evidence.push(`selector:${selector}`);
  if (tier === 4) evidence.push('regex_class_match');

  const ld = linkDensity(el, $);
  if (ld > 0.5) evidence.push(`high_link_density:${ld.toFixed(2)}`);

  const lc = linkCount(el, $);
  evidence.push(`link_count:${lc}`);

  if ($(el).attr('role')) evidence.push(`aria:${$(el).attr('role')}`);
  if ($(el).attr('aria-label')) evidence.push(`aria-label:${$(el).attr('aria-label')}`);

  return evidence;
}

function classifyNavSubtypes(blocks, $) {
  return blocks.map(block => {
    const el = block.node;
    const classId = getClassId(el, $);
    const ariaLabel = ($(el).attr('aria-label') || '').toLowerCase();

    if (
      PATTERNS.breadcrumb.test(classId) ||
      PATTERNS.breadcrumb.test(ariaLabel) ||
      $(el).find('[itemprop="breadcrumb"]').length ||
      isBreadcrumbStructure(el, $)
    ) {
      return { ...block, type: 'breadcrumbs', confidence: block.confidence * 0.6 };
    }

    if (
      PATTERNS.toc.test(classId) ||
      ($(el).closest('main, article, [role="main"]').length > 0 && hasOnlyAnchorLinks(el, $))
    ) {
      return { ...block, type: 'toc', confidence: block.confidence * 0.7 };
    }

    if (PATTERNS.pagination.test(classId) || isPaginationStructure(el, $)) {
      return { ...block, type: 'pagination', confidence: block.confidence * 0.5 };
    }

    const isInFooter = $(el).closest('footer, [role="contentinfo"]').length > 0 ||
                        $(el).parents().filter((_, p) => /footer/i.test(getClassId(p, $))).length > 0;
    if (isInFooter) {
      return { ...block, type: 'footer_nav' };
    }

    return { ...block, type: 'primary_nav' };
  });
}

function isBreadcrumbStructure(el, $) {
  const links = $(el).find('a');
  if (links.length < 2 || links.length > 10) return false;

  const text = $(el).text() || '';
  const separators = (text.match(/[>›»\/→|]/g) || []).length;
  return separators >= links.length - 1;
}

function hasOnlyAnchorLinks(el, $) {
  const links = $(el).find('a');
  if (links.length < 2) return false;

  let anchorCount = 0;
  links.each((_, a) => {
    const href = $(a).attr('href') || '';
    if (href.startsWith('#')) anchorCount++;
  });
  return anchorCount / links.length > 0.7;
}

function isPaginationStructure(el, $) {
  const links = $(el).find('a');
  if (links.length < 2 || links.length > 15) return false;

  let pageLinks = 0;
  links.each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = ($(a).text() || '').trim();
    if (/[?&]page=|\/page\/|\bpage\b/i.test(href) || /^\d+$/.test(text)) {
      pageLinks++;
    }
  });
  return pageLinks / links.length > 0.5;
}


// ============================================================
//  CONTENT DETECTION (5-Tier Cascade + Scoring Fallback)
// ============================================================

function findContentBlocks($, navBlocks, metadata) {
  const navNodes = new Set(navBlocks.map(b => b.node));

  for (const group of CONTENT_TIERS) {
    const found = collectContentTier($, group, navNodes);
    if (found.length > 0) {
      const cleaned = found.map(block => cleanContentBlock(block, $));
      const valid = cleaned.filter(b => wordCount(b.node, $) >= THRESHOLDS.MIN_CONTENT_WORDS);
      if (valid.length > 0) return valid;
    }
  }

  return scoringFallback($, navNodes, metadata);
}

function collectContentTier($, group, navNodes) {
  const blocks = [];
  const nodeSet = new Set();

  for (const sel of group.selectors) {
    $(sel).each((_, el) => {
      if (navNodes.has(el)) return;
      if (hasAncestorInSet(el, $, navNodes)) return;
      if (nodeSet.has(el)) return;
      if (hasAncestorInSet(el, $, nodeSet)) return;

      const ld = linkDensity(el, $);
      if (ld > THRESHOLDS.LINK_DENSITY_CONTENT_MAX + 0.2) return;

      nodeSet.add(el);
      blocks.push({
        node: el,
        html: outerHtml(el, $),
        tag: tagName(el, $),
        selector: sel,
        cssSelector: sel,
        tier: group.tier,
        confidence: calcContentConfidence(el, $, group.tier),
        type: 'main_content',
        evidence: buildContentEvidence(el, $, sel, group.tier),
        features: computeFeatures(el, $),
      });
    });
  }

  if (group.tier === 2 && blocks.length > 1) {
    return [selectBestArticle(blocks, $)];
  }

  return blocks;
}

function selectBestArticle(blocks, $) {
  return blocks.reduce((best, current) => {
    const bestScore = wordCount(best.node, $) * (1 - linkDensity(best.node, $));
    const currentScore = wordCount(current.node, $) * (1 - linkDensity(current.node, $));
    return currentScore > bestScore ? current : best;
  });
}

function calcContentConfidence(el, $, tier) {
  let base = TIER_CONFIDENCE[tier] || 0.7;

  const ld = linkDensity(el, $);
  if (ld < 0.1) base += 0.03;
  else if (ld > 0.25) base -= 0.05;

  const wc = wordCount(el, $);
  if (wc > 200) base += 0.02;
  else if (wc < 50) base -= 0.05;

  const hc = headingCount(el, $);
  const pc = paragraphCount(el, $);
  if (hc > 0 && pc > 2) base += 0.02;

  return Math.max(0, Math.min(1, Math.round(base * 100) / 100));
}

function buildContentEvidence(el, $, selector, tier) {
  const evidence = [];
  const tag = tagName(el, $);

  if (tier <= 2) evidence.push(`semantic:${tag}`);
  if (tier === 3) evidence.push(`microdata:${selector}`);
  if (tier >= 4) evidence.push(`selector:${selector}`);

  const ld = linkDensity(el, $);
  if (ld < 0.15) evidence.push('low_link_density');

  const hc = headingCount(el, $);
  if (hc > 0) evidence.push(`headings:${hc}`);

  const pc = paragraphCount(el, $);
  if (pc > 0) evidence.push(`paragraphs:${pc}`);

  const classId = getClassId(el, $);
  if (PATTERNS.positive.test(classId)) evidence.push('class_positive');

  return evidence;
}


// ============================================================
//  HEURISTIC SCORING (Readability-Inspired Fallback)
// ============================================================

function scoringFallback($, navNodes, metadata) {
  const candidates = new Map();

  $('p, pre, td, section').each((_, el) => {
    const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    if (text.length < 25) return;

    const parent = $(el).parent()[0];
    const grandparent = $(el).parent().parent()[0];

    if (!parent || navNodes.has(parent)) return;

    if (!candidates.has(parent)) {
      candidates.set(parent, { node: parent, score: initNodeScore(parent, $) });
    }
    if (grandparent && !navNodes.has(grandparent) && !candidates.has(grandparent)) {
      candidates.set(grandparent, { node: grandparent, score: initNodeScore(grandparent, $) });
    }

    const textScore = 1 + commaCount(el, $) + Math.min(3, Math.floor(text.length / 100));

    candidates.get(parent).score += textScore;
    if (grandparent && candidates.has(grandparent)) {
      candidates.get(grandparent).score += textScore / 2;
    }
  });

  for (const [node, data] of candidates) {
    const classId = getClassId(node, $);
    if (PATTERNS.positive.test(classId)) data.score += THRESHOLDS.SCORING_POSITIVE;
    if (PATTERNS.negative.test(classId)) data.score += THRESHOLDS.SCORING_NEGATIVE;

    const ld = linkDensity(node, $);
    data.score *= (1 - ld);
  }

  const sorted = [...candidates.values()]
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (sorted.length === 0) {
    return baselineFallback($, navNodes, metadata);
  }

  const best = sorted[0];
  const threshold = Math.max(10, best.score * THRESHOLDS.SIBLING_SCORE_RATIO);
  const resultNodes = [best];

  for (const cand of sorted.slice(1)) {
    if (cand.score >= threshold && !isAncestorOf($, best.node, cand.node)) {
      resultNodes.push(cand);
    }
  }

  return resultNodes.slice(0, 3).map(c => {
    const block = {
      node: c.node,
      html: outerHtml(c.node, $),
      tag: tagName(c.node, $),
      selector: 'scoring',
      cssSelector: null,
      tier: 6,
      confidence: TIER_CONFIDENCE[6],
      type: 'main_content',
      evidence: ['heuristic_scoring', `score:${c.score.toFixed(1)}`],
      features: computeFeatures(c.node, $),
    };
    return cleanContentBlock(block, $);
  });
}

function initNodeScore(node, $) {
  const tag = tagName(node, $);
  return TAG_BASE_SCORES[tag] || 0;
}

function baselineFallback($, navNodes, metadata) {
  const jsonLdContent = (metadata && typeof metadata.jsonLdContent === 'string')
    ? metadata.jsonLdContent.trim()
    : '';

  if (jsonLdContent.length >= THRESHOLDS.MIN_EXTRACTED_SIZE) {
    const looksLikeHtml = /<\s*\/?\s*\w+[\s>]/.test(jsonLdContent);
    const paragraphs = looksLikeHtml
      ? null
      : jsonLdContent
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean);

    const html = looksLikeHtml
      ? `<article>${jsonLdContent}</article>`
      : `<article>${paragraphs.map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`).join('')}</article>`;

    const wc = jsonLdContent.split(/\s+/).filter(Boolean).length;

    return [{
      node: $('body')[0] || $('html')[0],
      html,
      tag: 'article',
      selector: 'jsonld:articleBody',
      cssSelector: null,
      tier: 6,
      confidence: 0.55,
      type: 'main_content',
      evidence: ['jsonld_articleBody'],
      features: {
        textLength: jsonLdContent.length,
        wordCount: wc,
        linkDensity: 0,
        linkCount: 0,
        headingCount: 0,
        paragraphCount: looksLikeHtml ? 0 : paragraphs.length,
        listItemCount: 0,
        ttr: 0,
      },
    }];
  }

  const fallbackSelectors = ['article', 'p', 'blockquote', 'pre'];

  for (const sel of fallbackSelectors) {
    const elements = $(sel).filter((_, el) => !navNodes.has(el) && wordCount(el, $) > 10);
    if (elements.length === 0) continue;

    const htmlParts = [];
    elements.each((_, el) => { htmlParts.push(outerHtml(el, $)); });
    const combined = htmlParts.join('\n');

    if (combined.length > THRESHOLDS.MIN_EXTRACTED_SIZE) {
      return [{
        node: elements[0],
        html: combined,
        tag: sel,
        selector: `baseline:${sel}`,
        cssSelector: sel,
        tier: 6,
        confidence: 0.5,
        type: 'main_content',
        evidence: ['baseline_fallback', `source_tag:${sel}`, `elements:${elements.length}`],
        features: { textLength: combined.length, wordCount: 0, linkDensity: 0, linkCount: 0, headingCount: 0, paragraphCount: 0, listItemCount: 0, ttr: 0 },
      }];
    }
  }

  const bodyText = $('body').text().trim();
  if (bodyText.length > THRESHOLDS.MIN_EXTRACTED_SIZE) {
    return [{
      node: $('body')[0],
      html: $('body').html() || '',
      tag: 'body',
      selector: 'baseline:body',
      cssSelector: 'body',
      tier: 6,
      confidence: 0.3,
      type: 'main_content',
      evidence: ['baseline_body_fallback'],
      features: computeFeatures($('body')[0], $),
    }];
  }

  return [];
}


// ============================================================
//  CONTENT CLEANING
// ============================================================

function cleanContentBlock(block, $) {
  const $clone = cheerio.load(block.html, { decodeEntities: false });

  $clone(NOISE_WITHIN_CONTENT).remove();

  $clone('*').each((_, el) => {
    const classId = getClassId(el, $clone);
    if (classId && PATTERNS.noiseClassId.test(classId) && !PATTERNS.contentClassId.test(classId)) {
      $clone(el).remove();
    }
  });

  $clone('div, section, aside, ul, ol').each((_, el) => {
    const total = textLen(el, $clone);
    if (total === 0) return;

    const ltl = linkTextLen(el, $clone);
    const ld = ltl / total;
    const lc = linkCount(el, $clone);

    if (ld > 0.8 && lc > 2 && total < 500) {
      $clone(el).remove();
    }
  });

  $clone('form').remove();

  const emptyTags = ['div', 'p', 'span', 'section', 'b', 'em', 'i', 'strong'];
  for (const tag of emptyTags) {
    $clone(tag).each((_, el) => {
      if (!$clone(el).text().trim() && !$clone(el).find('img, table').length) {
        $clone(el).remove();
      }
    });
  }

  const cleanedHtml = $clone('body').html() || $clone.html();

  return {
    ...block,
    html: cleanedHtml.trim(),
    features: block.features,
  };
}


// ============================================================
//  MAIN PIPELINE
// ============================================================

function getDataFromText(input, options = {}) {
  let html;

  if (options.inputType === 'file') {
    html = fs.readFileSync(input, 'utf-8');
  } else if (typeof input === 'string' && /\.(html?|xhtml)$/i.test(input)) {
    const resolved = path.resolve(input);
    if (fs.existsSync(resolved)) {
      html = fs.readFileSync(resolved, 'utf-8');
    } else {
      html = input;
    }
  } else {
    html = input;
  }

  if (!html || typeof html !== 'string') {
    throw new Error('Input must be an HTML string or a valid file path');
  }

  const $ = cheerio.load(html, { decodeEntities: false });

  const metadata = extractMetadata($);
  const forms = findFormBlocks($);
  removeJunk($);
  const navigation = findNavigationBlocks($);
  const content = findContentBlocks($, navigation, metadata);

  const stripNode = (block) => {
    const { node, ...rest } = block;
    return rest;
  };

  const navBlocks = navigation.map(stripNode);
  const contentBlocks = content.map(stripNode);
  const formBlocks = forms.map(stripNode);

  if (!options.raw) {
    const turndown = createTurndownService();
    for (const block of navBlocks) {
      block.markdown = turndown.turndown(block.html);
    }
    for (const block of contentBlocks) {
      block.markdown = turndown.turndown(block.html);
    }
  }

  const result = {
    metadata,
    navigation: navBlocks,
    content: contentBlocks,
    forms: formBlocks,
  };

  if (options.outputFile) {
    const outPath = path.resolve(options.outputFile);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
  }

  return result;
}


// ============================================================
//  EXPORTS + CLI
// ============================================================

module.exports = getDataFromText;

if (require.main === module) {
  const args = process.argv.slice(2);
  const rawIdx = args.indexOf('--raw');
  const raw = rawIdx !== -1;
  if (raw) args.splice(rawIdx, 1);

  if (args.length < 1) {
    console.log('Usage: node getDataFromText.js <input.html> [output.json] [--raw]');
    console.log('  <input.html>   Path to HTML file');
    console.log('  [output.json]  Optional: save result to JSON file');
    console.log('  --raw          Return raw HTML blocks without Markdown conversion');
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args.find(a => !a.startsWith('--') && a !== inputFile) || null;

  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const result = getDataFromText(inputFile, {
    inputType: 'file',
    outputFile,
    raw,
  });

  if (!outputFile) {
    const summarizeBlock = (b) => {
      const info = {
        type: b.type,
        tier: b.tier,
        confidence: b.confidence,
        selector: b.selector,
        evidence: b.evidence,
        features: b.features,
      };
      if (b.markdown != null) {
        const preview = b.markdown.substring(0, 300);
        info.markdownPreview = preview + (b.markdown.length > 300 ? '...' : '');
      } else {
        const preview = b.html.substring(0, 200);
        info.htmlPreview = preview + (b.html.length > 200 ? '...' : '');
      }
      return info;
    };

    const summarizeForm = (b) => ({
      type: b.type,
      tier: b.tier,
      confidence: b.confidence,
      selector: b.selector,
      evidence: b.evidence,
      features: b.features,
      htmlPreview: b.html.substring(0, 200) + (b.html.length > 200 ? '...' : ''),
    });

    const summary = {
      metadata: result.metadata,
      navigation: result.navigation.map(summarizeBlock),
      content: result.content.map(summarizeBlock),
      forms: result.forms.map(summarizeForm),
    };
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Result saved to ${outputFile}`);
    console.log(`  Navigation blocks: ${result.navigation.length}`);
    console.log(`  Content blocks: ${result.content.length}`);
    console.log(`  Form blocks: ${result.forms.length}`);
    console.log(`  Mode: ${raw ? 'raw HTML' : 'HTML + Markdown'}`);
  }
}
