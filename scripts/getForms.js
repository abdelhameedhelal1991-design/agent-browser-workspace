'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const getDataFromText = require('../utils/getDataFromText');
const { initBrowser, parseBaseFlags, flagsToBrowserOptions, releaseBrowser, getResolvedSiteInfoForUrl } = require('./_shared');

/**
 * Get all forms from the current (or navigated-to) page with classification
 * and parsed field selectors ready for browser.fill() / browser.fillForm().
 *
 * @param {object} [options]
 * @param {import('../utils/browserUse')} [options.browser]  Existing BrowserUse instance.
 * @param {string}  [options.html]          Pre-fetched HTML (skips browser.getHtml()).
 * @param {string}  [options.url]           URL to navigate to (null = current page).
 * @param {boolean|string} [options.cdp]    CDP connection flag / endpoint.
 * @param {boolean} [options.launch]        Force launch mode.
 * @param {boolean} [options.headless]      Headless mode.
 * @param {number}  [options.timeout]       Timeout.
 * @returns {Promise<{forms: Array, metadata: object, site?: object|null}>}
 */
async function getForms(options = {}) {
  const {
    url,
    html: preloadedHtml,
    ...browserOptions
  } = options;

  const { browser, ownsInstance } = await initBrowser(browserOptions);

  try {
    if (url) {
      await browser.goto(url, { timeout: browserOptions.timeout });
    }

    const html = preloadedHtml || await browser.getHtml();
    const pageUrl = browser.page ? browser.getUrl() : '';

    const data = getDataFromText(html, { raw: true });

    const forms = data.forms.map(form => ({
      ...form,
      fields: parseFormFields(form.html, form.cssSelector || ''),
    }));

    return {
      forms,
      metadata: {
        ...data.metadata,
        url: pageUrl,
      },
      site: getResolvedSiteInfoForUrl(pageUrl),
    };
  } finally {
    await releaseBrowser(browser, ownsInstance);
  }
}

/**
 * Parse interactive fields from a form's HTML snippet.
 * Returns an array of field descriptors with CSS selectors suitable for
 * browser.fill() / browser.fillForm().
 *
 * @param {string} formHtml   Raw HTML of the form.
 * @param {string} formSelector  CSS selector of the form on the page.
 * @returns {Array<{tag:string, type:string, name:string, id:string, placeholder:string, value:string, selector:string, options?:Array}>}
 */
function parseFormFields(formHtml, formSelector) {
  const $ = cheerio.load(formHtml, { decodeEntities: false });
  const fields = [];
  const prefix = formSelector ? `${formSelector} ` : '';

  $('input, select, textarea, button').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    const type = ($el.attr('type') || '').toLowerCase();

    if (tag === 'input' && (type === 'hidden' || type === 'submit' && !$el.attr('value'))) {
      if (type === 'hidden') return;
    }

    const name = $el.attr('name') || '';
    const id = $el.attr('id') || '';
    const placeholder = $el.attr('placeholder') || '';
    const value = $el.attr('value') || '';
    const ariaLabel = $el.attr('aria-label') || '';
    const text = tag === 'button' ? $el.text().trim() : '';

    const selector = buildFieldSelector(prefix, tag, { type, name, id, ariaLabel });

    const field = { tag, type: type || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : ''), name, id, placeholder, value, selector };

    if (text) field.text = text;
    if (ariaLabel) field.ariaLabel = ariaLabel;

    if (tag === 'select') {
      field.options = [];
      $el.find('option').each((__, opt) => {
        const $opt = $(opt);
        field.options.push({
          value: $opt.attr('value') || '',
          text: $opt.text().trim(),
          selected: $opt.attr('selected') !== undefined,
        });
      });
    }

    fields.push(field);
  });

  return fields;
}

/**
 * Build the most specific CSS selector for a form field.
 * Preference: #id > [name] > [aria-label] > tag[type]
 */
function buildFieldSelector(prefix, tag, attrs) {
  if (attrs.id) {
    return `${prefix}#${cssEscape(attrs.id)}`;
  }
  if (attrs.name) {
    return `${prefix}${tag}[name="${attrs.name}"]`;
  }
  if (attrs.ariaLabel) {
    return `${prefix}${tag}[aria-label="${attrs.ariaLabel}"]`;
  }
  if (attrs.type) {
    return `${prefix}${tag}[type="${attrs.type}"]`;
  }
  return `${prefix}${tag}`;
}

/** CSS.escape polyfill for Node.js (covers common ID characters). */
function cssEscape(value) {
  return String(value).replace(/([^\w-])/g, '\\$1');
}


// ============================================================
//  EXPORTS
// ============================================================

module.exports = getForms;


// ============================================================
//  CLI
// ============================================================

if (require.main === module) {
  const HELP = `
Usage: node scripts/getForms.js [options]

Options:
  --url <url>             Navigate to URL before extracting (default: current page)
  --output <file>         Save result to JSON file (default: print to stdout)
  --profile <name>        Chrome profile name (default: AgentProfile)
  --cdp [endpoint]        Connect via CDP (default: http://localhost:9222)
  --launch                Force launch a new browser
  --headless              Run headless
  --timeout <ms>          Timeout (default: 30000)
  --help                  Show this help
`.trim();

  (async () => {
    const argv = process.argv.slice(2);

    if (argv.includes('--help')) {
      console.log(HELP);
      process.exit(0);
    }

    const flags = parseBaseFlags(argv);
    let outputFile = null;

    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--output') outputFile = argv[++i];
    }

    const result = await getForms({
      ...flagsToBrowserOptions(flags),
      url: flags.url,
    });

    if (outputFile) {
      const absPath = path.resolve(outputFile);
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, JSON.stringify(result, null, 2), 'utf-8');
      console.error(`Forms saved to: ${absPath}`);
      console.error(`Total forms: ${result.forms.length}`);
      for (const f of result.forms) {
        console.error(`  [${f.type}] ${f.selector} (${f.fields.length} fields, confidence: ${f.confidence})`);
      }
    } else {
      const summary = {
        metadata: result.metadata,
        forms: result.forms.map(f => ({
          type: f.type,
          selector: f.selector,
          confidence: f.confidence,
          tier: f.tier,
          evidence: f.evidence,
          features: f.features,
          fields: f.fields,
          htmlPreview: f.html.substring(0, 200) + (f.html.length > 200 ? '...' : ''),
        })),
      };
      console.log(JSON.stringify(summary, null, 2));
    }
  })().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
