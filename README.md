# Z.ai Conversation Scraper

Scrape Z.ai conversations from `chat.z.ai` and save them as clean Markdown.

It supports both normal conversation URLs (`/c/<id>`) and shared conversation URLs (`/s/<id>`). Private conversations can be accessed through a persistent Playwright browser profile or a saved storage-state file.

## Features

- API-first extraction of complete Z.ai message history
- Active-branch reconstruction from Z.ai message parent/child links
- Direct hydration of missing ancestors when only recent messages are initially exposed
- Z.ai-specific DOM selectors with broad structural fallbacks
- Normal (`/c/<id>`) and shared (`/s/<id>`) conversations
- Persistent Chromium profiles for authenticated private chats
- Optional Playwright storage-state loading and saving
- DOM scrolling and bounded history preloading only as a fallback
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

By default, the scraper reads the complete conversation from Z.ai's own history endpoints. Passing `--selector` explicitly disables the API path and forces rendered-DOM extraction, which is useful only for debugging or adapting to an API change.

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

## Extraction Strategy

The scraper first requests the conversation history used by Z.ai itself:

- Shared conversations: `/api/v1/chats/share/<share-id>`
- Private conversations: `/api/v1/chats/<conversation-id>`
- Missing message bodies, when necessary: `/api/v1/chats/<id>/messages/batch`

Z.ai stores messages as a tree. The scraper starts at `currentId`, follows each message's `parentId`, and requests missing ancestors from the batch endpoint until it reaches the root. It therefore does not require older messages to remain mounted in the rendered DOM—or even to be present in the initial history response.

A successful API-backed run reports the number of exported messages, active-branch records, and cached API records. The old `No internal scroll container was identified` warning should appear only when the API path failed and the scraper had to use its less reliable DOM fallback.

If those endpoints fail or their schema changes, the scraper falls back to rendered-DOM extraction and bounded scrolling. Z.ai is a private web application, so both its API and DOM can change without notice. Use `--debug-html` to capture the rendered page, or pass `--selector` to force and customize the DOM path.
