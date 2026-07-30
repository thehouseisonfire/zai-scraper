# Z.ai Conversation Scraper

Scrape Z.ai conversations from `chat.z.ai` and save them as clean Markdown.

It supports both normal conversation URLs (`/c/<id>`) and shared conversation URLs (`/s/<id>`). Private conversations can be accessed through a persistent Playwright browser profile or a saved storage-state file.

## Features

- Captures the successful history responses loaded by Z.ai itself
- Role-aware decoding of user `content` and assistant `content_blocks`
- Active-branch reconstruction from Z.ai message parent/child links
- Incremental network and DOM collection for virtualized older messages
- Z.ai-specific DOM selectors with broad structural fallbacks
- Normal (`/c/<id>`) and shared (`/s/<id>`) conversations
- Persistent Chromium profiles for authenticated private chats
- Optional Playwright storage-state loading and saving
- Scrolls every real scroll surface instead of guessing one container
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

| Flag                          | Description                                   |
| ----------------------------- | --------------------------------------------- |
| `-o, --output <path>`         | Output Markdown file                          |
| `--selector <css>`            | Override automatic message-root detection     |
| `--timeout <ms>`              | Navigation/content timeout (default: `60000`) |
| `--debug-html <path>`         | Save the rendered page HTML                   |
| `--profile-dir <path>`        | Use a persistent Chromium profile             |
| `--storage-state <path>`      | Load Playwright storage state                 |
| `--save-storage-state <path>` | Save storage state after scraping             |
| `--include-thinking`          | Include Z.ai thinking/reasoning blocks        |
| `--headed`                    | Show the Chromium window                      |

`--profile-dir` and `--storage-state` are mutually exclusive because persistent Playwright contexts cannot be initialized from a storage-state file.

By default, the scraper listens to the history requests made by the Z.ai page itself and consumes their successful responses. This matters because directly repeating the nominal shared-history endpoint may return `403 Forbidden` even while the page is able to render the conversation. Passing `--selector` explicitly disables network-history parsing and forces incremental rendered-DOM extraction.

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

## Tests

```bash
bun test
```

The regression suite covers assistant replies stored exclusively in `content_blocks`, reasoning filtering, captured metadata/batch merging, nested role metadata, virtualized-window ordering, and the fallback `content` representation.

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

## Extraction Strategy

The scraper installs its Playwright response listener **before navigation**. It then consumes successful conversation and `messages/batch` responses made by the Z.ai application itself, rather than assuming that a separately issued request to `/api/v1/chats/share/<id>` will be authorized.

Z.ai stores messages as a parent-linked tree. The scraper merges every captured batch, begins at `currentId` when available, and follows `parentId` to reconstruct the active branch. While that branch is incomplete, it scrolls every scrollable page element to the top and collects newly loaded response batches. This follows the application's own lazy-loading path without requiring the scraper to know private request headers.

Message bodies are role-specific: user prompts are read from `content`, while assistant replies are decoded primarily from `content_blocks` with `content` retained as a fallback. Reasoning blocks are separated from answer blocks and included only with `--include-thinking`.

If no recognizable history response is available, the DOM fallback no longer preloads and then reads only the final virtualized window. Instead, it snapshots each rendered window while moving upward, deduplicates turns by Z.ai message ID, and prepends newly discovered older turns. This is less authoritative than the response-backed path but does not silently discard windows that Z.ai unmounts.

A successful response-backed run reports the number of exported messages, active-branch records, and cached API records. A fallback run reports the growing count of distinct rendered turn blocks. If neither count grows while scrolling, use `--headed --debug-html page.html` to inspect a fresh Z.ai DOM/network change.

Z.ai is a private web application, so both its endpoints and rendered structure may change without notice.
