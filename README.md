# Z.ai Conversation Scraper

Scrape Z.ai conversations from `chat.z.ai` and save them as clean Markdown.

It supports both normal conversation URLs (`/c/<id>`) and shared conversation URLs (`/s/<id>`). Private conversations can be accessed through a persistent Playwright browser profile or a saved storage-state file.

## Features

- Z.ai-specific selectors with broad structural fallbacks
- Normal (`/c/<id>`) and shared (`/s/<id>`) conversations
- Persistent Chromium profiles for authenticated private chats
- Optional Playwright storage-state loading and saving
- Internal scroll-container discovery and bounded history preloading
- Role inference from message IDs, attributes, classes, and content structure
- Hidden reasoning/thinking blocks excluded by default
- Atomic file writes (temporary file + rename)
- Optional rendered HTML capture for diagnosing DOM changes
- GFM output, including tables, fenced code, strikethrough, and task lists

## Prerequisites

- [Bun](https://bun.sh)
- [Playwright Chromium](https://playwright.dev)

## Setup

```bash
bun install
bunx playwright install chromium
```

## Usage

### Shared conversation

```bash
bun run scrape "https://chat.z.ai/s/<share-id>"
```

### Private conversation

Use a dedicated persistent browser profile. On the first run, launch headed, sign in in the opened Chromium window, and let the scraper continue once the conversation appears:

```bash
bun run scrape \
  --headed \
  --profile-dir .zai-profile \
  "https://chat.z.ai/c/<conversation-id>"
```

Later runs can reuse the same profile headlessly:

```bash
bun run scrape \
  --profile-dir .zai-profile \
  "https://chat.z.ai/c/<conversation-id>"
```

Do not point `--profile-dir` at your normal Chromium/Chrome profile. Use a scraper-specific directory.

## Options

| Flag | Description |
|------|-------------|
| `-o, --output <path>` | Output Markdown file |
| `--selector <css>` | Override automatic message-root detection |
| `--timeout <ms>` | Navigation/content timeout (default: `60000`) |
| `--debug-html <path>` | Save the rendered page HTML |
| `--profile-dir <path>` | Use a persistent Chromium profile |
| `--storage-state <path>` | Load Playwright storage state |
| `--save-storage-state <path>` | Save storage state after scraping |
| `--include-thinking` | Include Z.ai thinking/reasoning blocks |
| `--headed` | Show the Chromium window |

`--profile-dir` and `--storage-state` are mutually exclusive because persistent Playwright contexts cannot be initialized from a storage-state file.

## Examples

```bash
# Shared conversation with an explicit output file
bun run scrape -o conversation.md "https://chat.z.ai/s/<share-id>"

# First authenticated run
bun run scrape --headed --profile-dir .zai-profile \
  "https://chat.z.ai/c/<conversation-id>"

# Capture the rendered DOM when selectors stop matching
bun run scrape --headed --profile-dir .zai-profile \
  --debug-html zai-page.html \
  "https://chat.z.ai/c/<conversation-id>"

# Force a replacement selector
bun run scrape --selector '#chat-container [id^="message-"]' \
  "https://chat.z.ai/s/<share-id>"

# Include visible/embedded reasoning blocks explicitly
bun run scrape --include-thinking "https://chat.z.ai/s/<share-id>"
```

## Build

Compile to JavaScript for execution with Node.js:

```bash
bun run build
node dist/zai-to-markdown.js "https://chat.z.ai/s/<share-id>"
```

## Output Format

```markdown
# [Conversation Title]

**Source:** <https://chat.z.ai/c/...>
**Scraped:** YYYY-MM-DD

---

## User
[User message]

## Z.ai
[Assistant response]
```

## Authentication Notes

The scraper never asks for, stores, or handles your password directly. Authentication is performed by Z.ai inside Chromium. A persistent profile or storage-state file can contain live session credentials, so keep it private and do not commit it.

## DOM Maintenance

Z.ai is a private web application and its DOM can change without notice. The default selector chain prioritizes current message-root IDs and Z.ai classes, then falls back to semantic role attributes and broader content selectors. When extraction fails, use `--debug-html` and, if needed, `--selector` to inspect and override message detection.
