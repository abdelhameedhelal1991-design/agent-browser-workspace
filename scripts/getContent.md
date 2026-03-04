# getContent

Extract Markdown content from the current (or specified) browser page. Downloads images from content blocks and rewrites Markdown image links to local paths. Saves the result to a file.

## Quick start

### CLI

```bash
# Content of the current page (CDP auto-detect)
node scripts/getContent.js --dir ./output --name article.md

# With navigation to a URL
node scripts/getContent.js --dir ./output --name article.md --url https://example.com/article

# Headless launch
node scripts/getContent.js --dir ./output --name article.md --url https://example.com --launch --headless
```

### API

```javascript
const getContent = require('./scripts/getContent');

const result = await getContent({
  dir: './output',
  name: 'article.md',
});

console.log(result.markdown);       // Markdown with local image paths
console.log(result.savedTo);        // absolute path to the saved file
console.log(result.images.length);  // number of downloaded images
```

## API

### `getContent(options)`

| Option | Type | Default | Description |
|-------|-----|---------|-------------|
| `dir` | `string` | **required** | Output directory for the Markdown file |
| `name` | `string` | **required** | Markdown filename |
| `url` | `string` | `null` | URL to navigate to (`null` = current page) |
| `imageSubdir` | `string` | `'images'` | Images subdirectory (relative to `dir`) |
| `minWidth` | `number` | `100` | Skip images narrower than this (px) |
| `minHeight` | `number` | `100` | Skip images shorter than this (px) |
| `browser` | `BrowserUse` | `null` | Existing browser instance to reuse |
| `html` | `string` | `null` | Pre-fetched HTML (skips `browser.getHtml()`) |
| `downloadImages` | `boolean` | `true` if `html` is not passed | If `html` is passed, controls whether images are still downloaded from the DOM |
| `cdp` | `boolean\|string` | — | CDP mode |
| `launch` | `boolean` | — | Force launch mode |
| `headless` | `boolean` | `false` | Headless |
| `timeout` | `number` | `30000` | Timeout |

### Result shape

```javascript
{
  markdown: '# Page title\n\nArticle text...\n\n![Photo](images/photo.jpg)',
  images: [
    {
      src: 'https://example.com/photo.jpg',
      alt: 'Photo',
      savedAs: '/abs/path/output/images/photo.jpg',
      size: 145832,
      success: true,
    },
    {
      src: 'https://example.com/broken.png',
      alt: '',
      success: false,
      error: 'HTTP 404',
    },
  ],
  savedTo: '/abs/path/output/article.md',
  metadata: {
    title: 'Page title',
    lang: 'en',
    description: '...',
  },
  site: {
    id: 'google-search',
    name: 'Google Search',
    host: 'www.google.com',
    controls: [
      { name: 'Search input', selector: 'textarea[name="q"], input[name="q"]', actions: ['fill', 'press:Enter'] }
    ]
  }
}
```

## Algorithm

```
Browser → getHtml()
       → getDataFromText(html) → content blocks + markdown
       → downloadImages({ selector: contentSelectors + ' img' })
       → build mapping: original URL → relative local path
       → replace image URLs in markdown
       → (site enrichment, if host matches a profile in scripts/sites/*)
       → save .md file
```

1. Initialize browser via `_shared.initBrowser()`
2. Optionally navigate to `url`
3. Get the page HTML
4. Extract content blocks via `getDataFromText` (with Markdown conversion)
5. Compute CSS selectors for content blocks to scope image downloads
6. Download images via `browser.downloadImages()` into `dir/imageSubdir/`
7. Build a mapping `originalURL → relativePath`
8. Replace image URLs in Markdown with local paths (regex `![alt](url)`)
9. Concatenate Markdown for all content blocks and save to file
10. Release the browser

## YouTube (content enrichment)

If `getContent()` is called on a YouTube page (`youtube.com`, `youtu.be`) and the URL matches a watch page (not Shorts), the script additionally extracts and prepends to the Markdown output (implementation is in `scripts/getContentYoutube.js`):

- video title;
- description (full text from `videoDetails.shortDescription`);
- top comments (up to 10 by likes; attempts to switch sorting to “Top comments”);
- captions/transcript — best-effort with fallback chain:
  - `captionTracks` → `timedtext` (json3/xml),
  - `youtubei/v1/get_transcript` (innertube),
  - UI “Show transcript” → reading `ytd-transcript-segment-renderer`.

Selectors and controls for YouTube are stored in `scripts/sites/youtube.json`.

## CLI

```
Usage: node scripts/getContent.js --dir <dir> --name <file> [options]

Options:
  --dir <dir>             Output directory for the Markdown file (required)
  --name <file>           Filename for the Markdown file (required)
  --url <url>             Navigate to URL before extracting (default: current page)
  --image-subdir <dir>    Subdirectory for images relative to --dir (default: images)
  --min-width <px>        Skip images narrower than this (default: 100)
  --min-height <px>       Skip images shorter than this (default: 100)
  --profile <name>        Chrome profile name (default: AgentProfile)
  --cdp [endpoint]        Connect via CDP (default: http://localhost:9222)
  --launch                Force launch a new browser
  --headless              Run headless
  --timeout <ms>          Timeout (default: 30000)
  --help                  Show this help
```

Operational logs go to stderr, data goes to stdout.

## Examples

### Extract an article with images

```javascript
const getContent = require('./scripts/getContent');

const result = await getContent({
  url: 'https://example.com/blog/post',
  dir: './articles/post-1',
  name: 'content.md',
  imageSubdir: 'img',
  minWidth: 200,
});

// Output structure:
//   articles/post-1/content.md     — markdown with ![...](img/photo.jpg)
//   articles/post-1/img/photo.jpg  — downloaded image
```

### Reuse an existing browser

```javascript
const BrowserUse = require('./utils/browserUse');
const getContent = require('./scripts/getContent');

const browser = await BrowserUse.connectCDP();
await browser.goto('https://example.com');

const result = await getContent({
  browser,         // reused, not closed after the call
  dir: './output',
  name: 'page.md',
});

// browser stays open
await browser.close();
```

### Infinite scroll: load content before extracting

```javascript
const BrowserUse = require('./utils/browserUse');
const getContent = require('./scripts/getContent');

const browser = await BrowserUse.connectCDP();
await browser.goto('https://news.example.com/feed');

// Scroll the feed to load all items
await browser.scroll({ times: 15, delay: 2000, timeout: 45000 });

// Extract full content (including content loaded on scroll)
const result = await getContent({
  browser,
  dir: './output',
  name: 'feed.md',
});

await browser.close();
```

### With pre-fetched HTML

```javascript
const getContent = require('./scripts/getContent');

const result = await getContent({
  browser: myBrowser,
  html: '<html>...</html>',   // HTML comes from here
  downloadImages: true,       // images are still downloaded from the DOM (if you need a full result)
  dir: './output',
  name: 'page.md',
});
```

## Dependencies

- [_shared](./_shared.md) — browser initialization
- [browserUse](../utils/browserUse.md) — Chrome control
- [getDataFromText](../utils/getDataFromText.md) — extract content from HTML

