---
title: Installation and setup
description: >
  How to install dependencies (Node.js, Playwright, Chrome), configure Chrome for automation
  with an isolated AgentProfile, start/stop background Chrome with CDP, create a Windows shortcut,
  and verify the setup. Covers macOS/Linux/Windows, custom profiles, and profile paths.
when_to_read: >
  Read when you need to install the project, set up Chrome for the first time, troubleshoot
  connection issues, switch Chrome profiles, or configure CDP on a non-default port.
related:
  - AGENT_BROWSER.md
  - utils/browserUse.md
---

# Installation and setup

## Requirements

- **Node.js** 18+ (20+ recommended)
- **Google Chrome** (regular desktop build)

## Install

```bash
npm install
npx playwright install chrome
```

## Configure Chrome for automation

All tools use a separate Chrome profile (`AgentProfile`) so your main browser profile is not affected. The profile is created automatically on first run.

### Quick start

```bash
npm run chrome
```

Chrome will start in the background with CDP on port 9222 and the `AgentProfile` profile. Scripts will connect automatically.

Stop it:

```bash
npm run chrome:stop
```

Use a different profile:

```bash
npm run chrome -- --profile Work
```

### Chrome shortcut (Windows)

For convenience, you can create a separate shortcut that launches Chrome with CDP enabled:

1. Find your Google Chrome shortcut, copy it (right click → “Copy”, then “Paste”).
2. Rename the copy, e.g. **Chrome Agent**.
3. Open Properties (right click → “Properties”).
4. In the **Target** field, append after `chrome.exe"`:

```
 --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\AgentProfile"
```

The full Target field will look similar to:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\AgentProfile"
```

5. Click **OK**.

Now launching this shortcut opens Chrome with a separate profile and CDP enabled. Scripts will connect automatically.

### macOS

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome/AgentProfile"
```

### Linux

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/google-chrome/AgentProfile"
```

## Profiles

By default the `AgentProfile` profile is used. A profile is a separate Chrome data directory (cookies, localStorage, history, extensions) isolated from your main browser.

Default profile paths:

| OS      | Path                                                       |
| ------- | ---------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\Google\Chrome\AgentProfile`                |
| macOS   | `~/Library/Application Support/Google/Chrome/AgentProfile` |
| Linux   | `~/.config/google-chrome/AgentProfile`                     |

To use another profile:

```bash
# CLI — any script
node scripts/getContent.js --profile Work --url https://example.com --dir ./out --name page.md

# API
const BrowserUse = require('./utils/browserUse');
const browser = await BrowserUse.launch({ profile: 'Work' });
const browserCdp = await BrowserUse.launchCDP({ profile: 'Work' });
```

## Verification

After installation, verify everything works:

```bash
# Start Chrome
npm run chrome

# Extract page content
node scripts/getContent.js --url https://example.com --dir ./test --name test.md

# Stop Chrome
npm run chrome:stop
```

## Documentation

- [AGENT_BROWSER.md](AGENT_BROWSER.md) — overview of all tools and when to use what
- [utils/browserUse.md](utils/browserUse.md) — Chrome control (API + CLI)
- [utils/getDataFromText.md](utils/getDataFromText.md) — extract data from HTML
- [scripts/](scripts/) — high-level scripts (getContent, getForms, getAll, googleSearch)
- [RESEARCH.md](RESEARCH.md) — deep-research methodology via Google Search
