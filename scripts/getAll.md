# getAll

Combine [getContent](./getContent.md) and [getForms](./getForms.md) into a single call. One browser session, one HTML snapshot — both results: Markdown content with local images and classified forms with fields.

## Quick start

### CLI

```bash
# Content + forms from the current page
node scripts/getAll.js --dir ./output --name article.md

# Navigate and save forms into a separate file
node scripts/getAll.js --dir ./output --name article.md --url https://example.com --forms-output ./output/forms.json

# Headless launch
node scripts/getAll.js --dir ./output --name page.md --url https://example.com --launch --headless
```

### API

```javascript
const getAll = require('./scripts/getAll');

const result = await getAll({
  dir: './output',
  name: 'article.md',
  url: 'https://example.com/article',
});

console.log(result.markdown);       // Markdown with local images
console.log(result.forms.length);   // number of forms found
console.log(result.savedTo);        // path to the saved file
```

## API

### `getAll(options)`

Accepts all options from `getContent` and `getForms`, plus:

| Option | Type | Default | Description |
|-------|-----|---------|-------------|
| `dir` | `string` | **required** | Output directory for the Markdown file |
| `name` | `string` | **required** | Markdown filename |
| `url` | `string` | `null` | URL to navigate to |
| `imageSubdir` | `string` | `'images'` | Images subdirectory |
| `minWidth` | `number` | `100` | Minimum image width (px) |
| `minHeight` | `number` | `100` | Minimum image height (px) |
| `formsOutput` | `string` | `null` | Path to save forms JSON (`{ forms, metadata, site }`) |
| `browser` | `BrowserUse` | `null` | Existing browser instance |
| `cdp` | `boolean\|string` | — | CDP mode |
| `launch` | `boolean` | — | Force launch mode |
| `headless` | `boolean` | `false` | Headless |
| `timeout` | `number` | `30000` | Timeout |

### Result shape

```javascript
{
  // From getContent
  markdown: '# Page title\n\nText...\n\n![Photo](images/photo.jpg)',
  images: [
    { src: 'https://...', savedAs: '/abs/path/...', success: true, size: 12345 },
  ],
  savedTo: '/abs/path/output/article.md',

  // From getForms
  forms: [
    {
      type: 'search',
      selector: '[role="search"]',
      confidence: 0.95,
      fields: [
        { tag: 'input', type: 'text', name: 'q', selector: '...' },
      ],
      // ... features, evidence, html
    },
  ],

  // Merged metadata
  metadata: {
    title: 'Page title',
    lang: 'en',
    description: '...',
    url: 'https://example.com/article',
  },

  // Site profile (if host matches scripts/sites/*.json)
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

## Optimization

HTML is fetched once via `browser.getHtml()` and passed to both functions through the `html` option. This avoids a repeated browser round-trip:

```
Browser → getHtml() → html string
                        ├── getContent({ html, browser, ... })
                        └── getForms({ html, browser, ... })
```

At the same time, `getAll` **does not disable image downloading**: `getContent` still downloads images from the DOM (`downloadImages: true`), while the HTML string is only a shared snapshot for parsing.

## CLI

```
Usage: node scripts/getAll.js --dir <dir> --name <file> [options]

Options:
  --dir <dir>             Output directory for the Markdown file (required)
  --name <file>           Filename for the Markdown file (required)
  --url <url>             Navigate to URL before extracting (default: current page)
  --image-subdir <dir>    Subdirectory for images relative to --dir (default: images)
  --min-width <px>        Skip images narrower than this (default: 100)
  --min-height <px>       Skip images shorter than this (default: 100)
  --forms-output <file>   Save forms to a separate JSON file
  --profile <name>        Chrome profile name (default: AgentProfile)
  --cdp [endpoint]        Connect via CDP (default: http://localhost:9222)
  --launch                Force launch a new browser
  --headless              Run headless
  --timeout <ms>          Timeout (default: 30000)
  --help                  Show this help
```

## Examples

### Full page analysis

```javascript
const getAll = require('./scripts/getAll');

const result = await getAll({
  url: 'https://shop.example.com/catalog',
  dir: './analysis',
  name: 'catalog.md',
  formsOutput: './analysis/forms.json',
});

// Content saved to ./analysis/catalog.md
// Images saved to ./analysis/images/
// Forms saved to ./analysis/forms.json

// Catalog filters
const filters = result.forms.filter(f => f.type === 'filter');
for (const filter of filters) {
  console.log(`Filter: ${filter.selector}`);
  for (const field of filter.fields) {
    if (field.tag === 'select') {
      console.log(`  ${field.name}: ${field.options.map(o => o.text).join(', ')}`);
    }
  }
}
```

### Reuse an existing browser

```javascript
const BrowserUse = require('./utils/browserUse');
const getAll = require('./scripts/getAll');

const browser = await BrowserUse.connectCDP();
await browser.goto('https://example.com');

const result = await getAll({
  browser,
  dir: './output',
  name: 'page.md',
});

// browser is NOT closed — ownsInstance === false
await browser.close();
```

## Dependencies

- [_shared](./_shared.md) — browser initialization
- [getContent](./getContent.md) — content extraction
- [getForms](./getForms.md) — form extraction

