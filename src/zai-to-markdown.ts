#!/usr/bin/env bun

import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  chromium,
  errors as playwrightErrors,
  type BrowserContext,
  type Page,
} from "playwright";
import TurndownService from "turndown";
import turndownPluginGfm from "turndown-plugin-gfm";

type Role = "User" | "Z.ai";

interface Metadata {
  title: string;
  url: string;
}

interface RawTurn {
  role: Role | null;
  html: string;
}

interface Message {
  role: Role;
  content: string;
}

interface CliOptions {
  url: URL;
  output?: string;
  debugHtml?: string;
  selector?: string;
  profileDir?: string;
  storageState?: string;
  saveStorageState?: string;
  timeoutMs: number;
  headed: boolean;
  includeThinking: boolean;
}

interface ScrapeResult {
  outputPath: string;
  messageCount: number;
  selector: string;
}

interface ContextHandle {
  context: BrowserContext;
  close(): Promise<void>;
}

const DEFAULT_TITLE = "Z.ai Conversation";
const DEFAULT_TIMEOUT_MS = 60_000;
const ZAI_HOSTNAMES = new Set(["chat.z.ai", "www.chat.z.ai"]);

const TITLE_SUFFIX = /\s*(?:\||-|—)\s*(?:Z\.ai|ZAI|Chat Z\.ai)\s*$/i;
const CONVERSATION_PATH = /^\/(?:c|s)\/[a-z0-9-]+(?:\/|$)/i;

/**
 * Ordered from current Z.ai message roots to progressively broader fallbacks.
 *
 * The first selector producing at least two usable top-level elements wins.
 * A one-turn conversation is still accepted when no selector finds two.
 */
const MESSAGE_SELECTORS = [
  '#chat-container [id^="message-"]',
  '[id^="message-"]',
  '#chat-container [data-message-author-role]',
  '#chat-container [data-role="user"], #chat-container [data-role="assistant"]',
  '#chat-container .user-message, #chat-container .assistant-message',
  '#chat-container .chat-user, #chat-container .markdown-prose:not(.chat-user)',
  '#chat-container .message-user, #chat-container .message-assistant',
  '#chat-container .chat-message-user, #chat-container .chat-message-assistant',
  '#chat-container article',
  '#chat-container .prose',
] as const;

const CONVERSATION_CONTENT_SELECTOR = [
  '#chat-container [id^="message-"]',
  "#chat-container .chat-user",
  "#chat-container .markdown-prose:not(.chat-user)",
  '#chat-container [data-message-author-role]',
  '#chat-container [data-role="user"]',
  '#chat-container [data-role="assistant"]',
].join(", ");

const SCROLL_CONTAINER_SELECTORS = [
  "#chat-container #messages-container",
  "#chat-container .flex.overflow-y-scroll.flex-col.w-full.h-full",
  "#chat-container .scrollbar-none.flex.flex-col",
  "#chat-container [data-pane-id] .overflow-y-scroll",
  "#chat-container [data-pane-id] .scrollbar-none",
] as const;

const THINKING_SELECTOR = ".thinking-chain-container, .thinking-block";

const UI_NOISE = new Set(
  [
    "copy",
    "copied",
    "edit",
    "regenerate",
    "retry",
    "share",
    "like",
    "dislike",
    "good response",
    "bad response",
    "stop generating",
    "continue generating",
  ].map((value) => value.toLowerCase()),
);

class UsageError extends Error {
  override readonly name = "UsageError";
}

class ExtractionError extends Error {
  override readonly name = "ExtractionError";
}

function printHelp(): void {
  console.log(
    `
Usage:
  zai-to-markdown [options] <url>

Scrape a Z.ai conversation and save it as Markdown.

Supported URLs:
  https://chat.z.ai/c/<conversation-id>
  https://chat.z.ai/s/<share-id>

Options:
  -o, --output <path>              Output Markdown file
      --selector <css>             Override automatic message detection
      --timeout <ms>               Navigation/content timeout
                                   Default: ${DEFAULT_TIMEOUT_MS}
      --debug-html <path>          Save the rendered page HTML
      --profile-dir <path>         Persistent Chromium profile for login
      --storage-state <path>       Load Playwright storage state
      --save-storage-state <path>  Save storage state after scraping
      --include-thinking           Include Z.ai thinking/reasoning blocks
      --headed                     Show the Chromium window
  -h, --help                       Show this help

Examples:
  bun run scrape "https://chat.z.ai/s/..."
  bun run scrape --headed --profile-dir .zai-profile "https://chat.z.ai/c/..."
  bun run scrape -o conversation.md "https://chat.z.ai/s/..."
  bun run scrape --debug-html page.html --headed "https://chat.z.ai/s/..."
`.trim(),
  );
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(
      `${option} must be a positive integer; received ${JSON.stringify(value)}.`,
    );
  }

  return parsed;
}

function parseUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`Invalid URL: ${JSON.stringify(value)}.`);
  }

  if (url.protocol !== "https:") {
    throw new UsageError("Z.ai conversation URLs must use HTTPS.");
  }

  if (!ZAI_HOSTNAMES.has(url.hostname.toLowerCase())) {
    throw new UsageError(
      `Expected a chat.z.ai URL; received hostname ${JSON.stringify(url.hostname)}.`,
    );
  }

  if (!CONVERSATION_PATH.test(url.pathname)) {
    throw new UsageError(
      "Expected a Z.ai conversation URL with /c/<id> or /s/<id> in its path.",
    );
  }

  return url;
}

function parseCliOptions(argv: string[]): CliOptions {
  const cliOptions = {
    output: {
      type: "string",
      short: "o",
    },
    selector: {
      type: "string",
    },
    timeout: {
      type: "string",
      default: String(DEFAULT_TIMEOUT_MS),
    },
    "debug-html": {
      type: "string",
    },
    "profile-dir": {
      type: "string",
    },
    "storage-state": {
      type: "string",
    },
    "save-storage-state": {
      type: "string",
    },
    "include-thinking": {
      type: "boolean",
      default: false,
    },
    headed: {
      type: "boolean",
      default: false,
    },
    help: {
      type: "boolean",
      short: "h",
      default: false,
    },
  } as const;

  const { values, positionals } = parseArgs({
    args: argv,
    options: cliOptions,
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (positionals.length === 0) {
    throw new UsageError("A Z.ai conversation URL is required.");
  }

  if (positionals.length > 1) {
    throw new UsageError(
      `Expected one URL, but received ${positionals.length} positional arguments.`,
    );
  }

  if (values["profile-dir"] !== undefined && values["storage-state"] !== undefined) {
    throw new UsageError("--profile-dir and --storage-state cannot be used together.");
  }

  const urlArgument = positionals[0];

  if (urlArgument === undefined) {
    throw new UsageError("A Z.ai conversation URL is required.");
  }

  return {
    url: parseUrl(urlArgument),
    timeoutMs: parsePositiveInteger(values.timeout, "--timeout"),
    headed: values.headed,
    includeThinking: values["include-thinking"],
    ...(values.output !== undefined ? { output: values.output } : {}),
    ...(values.selector !== undefined ? { selector: values.selector } : {}),
    ...(values["debug-html"] !== undefined ? { debugHtml: values["debug-html"] } : {}),
    ...(values["profile-dir"] !== undefined ? { profileDir: values["profile-dir"] } : {}),
    ...(values["storage-state"] !== undefined
      ? { storageState: values["storage-state"] }
      : {}),
    ...(values["save-storage-state"] !== undefined
      ? { saveStorageState: values["save-storage-state"] }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanTitle(title: string | undefined): string {
  const cleaned = title?.replace(TITLE_SUFFIX, "").replace(/\s+/g, " ").trim();

  return cleaned || DEFAULT_TITLE;
}

function cleanFilename(title: string): string {
  const filename = title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*]|[^\x20-\x7e]/g, "")
    .replace(/\s+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);

  return filename || "zai_conversation";
}

function configureTurndown(): TurndownService {
  const converter = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });

  converter.use(turndownPluginGfm.gfm);

  converter.remove(["script", "style", "noscript", "svg", "canvas"] as unknown as Parameters<
    TurndownService["remove"]
  >[0]);

  converter.addRule("unwrap-buttons", {
    filter: "button",
    replacement(content) {
      return content;
    },
  });

  converter.addRule("fenced-code-with-language", {
    filter(node) {
      return node.nodeName === "PRE" && node.firstElementChild?.nodeName === "CODE";
    },

    replacement(_content, node) {
      const codeElement = node.firstElementChild;

      if (codeElement === null || codeElement.nodeName !== "CODE") {
        return "";
      }

      const code = codeElement.textContent?.replace(/\n$/, "") ?? "";
      const className = codeElement.getAttribute("class") ?? "";
      const language = className.match(/(?:^|\s)(?:language-|lang-)([\w#+.-]+)/i)?.[1] ?? "";

      const longestBacktickSequence = Math.max(
        0,
        ...(code.match(/`+/g)?.map((value) => value.length) ?? []),
      );
      const fence = "`".repeat(Math.max(3, longestBacktickSequence + 1));

      return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
    },
  });

  return converter;
}

function cleanMarkdown(markdown: string, role: Role): string {
  const output: string[] = [];

  let openFence:
    | {
        character: "`" | "~";
        length: number;
      }
    | undefined;

  for (const originalLine of markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .split("\n")) {
    const line = originalLine.replace(/[ \t]+$/g, "");
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);

    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      const character = marker[0] as "`" | "~";

      if (openFence === undefined) {
        openFence = {
          character,
          length: marker.length,
        };
      } else if (character === openFence.character && marker.length >= openFence.length) {
        openFence = undefined;
      }

      output.push(line);
      continue;
    }

    if (openFence === undefined && UI_NOISE.has(trimmed.toLowerCase())) {
      continue;
    }

    output.push(line);
  }

  const collapsed = output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (collapsed.length === 0) {
    return "";
  }

  const lines = collapsed.split("\n");
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);

  if (firstContentLine !== -1) {
    const possibleRoleLabel = lines[firstContentLine]
      ?.trim()
      .replace(/^#{1,6}\s*/, "")
      .replace(/:$/, "")
      .toLowerCase();

    const expectedLabels =
      role === "User"
        ? new Set(["user", "you", "human"])
        : new Set(["z.ai", "zai", "assistant", "glm"]);

    if (possibleRoleLabel !== undefined && expectedLabels.has(possibleRoleLabel)) {
      lines.splice(firstContentLine, 1);
    }
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function navigate(page: Page, url: URL, timeoutMs: number): Promise<void> {
  console.log(`[-] Navigating to ${url.href}`);

  try {
    const response = await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    if (response !== null && !response.ok()) {
      throw new Error(`The server returned HTTP ${response.status()} ${response.statusText()}.`);
    }
  } catch (error) {
    if (error instanceof playwrightErrors.TimeoutError) {
      console.warn(
        `[!] Navigation exceeded ${timeoutMs} ms; attempting to use the DOM already loaded.`,
      );
      return;
    }

    throw new Error(`Navigation failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

async function describeMissingConversation(page: Page, requestedUrl: URL): Promise<string> {
  const state = await page.evaluate(() => {
    const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 2_000) ?? "";
    return {
      url: window.location.href,
      title: document.title,
      bodyText,
      hasChatInput: Boolean(document.querySelector("#chat-input")),
    };
  });

  const looksLikeAuthentication = /\b(?:sign in|log in|login|continue with google|verify email)\b/i.test(
    state.bodyText,
  );

  if (looksLikeAuthentication || (requestedUrl.pathname.startsWith("/c/") && !state.hasChatInput)) {
    return [
      "No conversation content appeared. The private chat may require authentication.",
      "Run with --headed --profile-dir .zai-profile, sign in in the opened browser,",
      "and keep that dedicated profile for later runs.",
      `Current page: ${state.url}`,
    ].join(" ");
  }

  return [
    `No conversation-like elements appeared on ${state.url}.`,
    "Z.ai may have changed its DOM, the link may be invalid, or the conversation may be unavailable.",
    "Use --debug-html to capture the rendered page and --selector to override detection.",
  ].join(" ");
}

async function waitForConversationContent(
  page: Page,
  selectors: readonly string[],
  requestedUrl: URL,
  timeoutMs: number,
): Promise<void> {
  console.log("[-] Waiting for conversation content");

  const combinedSelector = selectors.join(", ");

  try {
    await page.locator(combinedSelector).first().waitFor({
      state: "attached",
      timeout: timeoutMs,
    });
  } catch (error) {
    throw new ExtractionError(await describeMissingConversation(page, requestedUrl), {
      cause: error,
    });
  }
}

async function markBestScrollContainer(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ knownSelectors, messageSelector }) => {
      const marker = "data-zai-scraper-scroll-root";
      document.querySelectorAll(`[${marker}]`).forEach((element) => element.removeAttribute(marker));

      const candidates = new Set<HTMLElement>();

      for (const selector of knownSelectors) {
        document.querySelectorAll(selector).forEach((element) => {
          if (element instanceof HTMLElement) {
            candidates.add(element);
          }
        });
      }

      document.querySelectorAll(messageSelector).forEach((message) => {
        let current = message.parentElement;
        let depth = 0;

        while (current !== null && current !== document.body && depth < 10) {
          const style = window.getComputedStyle(current);
          if (style.overflowY === "auto" || style.overflowY === "scroll") {
            candidates.add(current);
          }
          current = current.parentElement;
          depth += 1;
        }
      });

      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

      let best: HTMLElement | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const candidate of candidates) {
        const style = window.getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        const messageCount = candidate.querySelectorAll(messageSelector).length;

        if (style.display === "none" || style.visibility === "hidden") continue;
        if (candidate.clientHeight < 180 || rect.width < 300) continue;

        let score = Math.min(messageCount, 100) * 200;
        score += Math.min(candidate.scrollHeight - candidate.clientHeight, 20_000) / 10;

        if (rect.height >= viewportHeight * 0.4) score += 600;
        if (rect.width >= viewportWidth * 0.45) score += 400;
        if (candidate.matches("#messages-container")) score += 1_000;
        if (candidate.closest("#chat-container")) score += 500;
        if (candidate.querySelector("#chat-input, textarea")) score -= 1_000;

        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }

      if (best === undefined) {
        return false;
      }

      best.setAttribute(marker, "true");
      return true;
    },
    {
      knownSelectors: SCROLL_CONTAINER_SELECTORS,
      messageSelector: CONVERSATION_CONTENT_SELECTOR,
    },
  );
}

async function preloadConversationHistory(page: Page): Promise<void> {
  console.log("[-] Preloading conversation history");

  const hasInternalScrollContainer = await markBestScrollContainer(page);

  if (!hasInternalScrollContainer) {
    console.warn("[!] No internal scroll container was identified; using the page scroll.");
  }

  let previousFingerprint = "";
  let stablePasses = 0;

  for (let pass = 0; pass < 40; pass += 1) {
    const fingerprint = await page.evaluate(
      ({ marker, messageSelector, internal }) => {
        const root = internal
          ? document.querySelector<HTMLElement>(`[${marker}="true"]`)
          : document.scrollingElement;

        if (root === null) {
          return "missing";
        }

        root.scrollTop = 0;

        const messages = Array.from(document.querySelectorAll(messageSelector));
        const first = messages[0];
        const last = messages.at(-1);

        return [
          root.scrollHeight,
          messages.length,
          first?.id ?? first?.textContent?.slice(0, 80) ?? "",
          last?.id ?? last?.textContent?.slice(0, 80) ?? "",
        ].join("|");
      },
      {
        marker: "data-zai-scraper-scroll-root",
        messageSelector: CONVERSATION_CONTENT_SELECTOR,
        internal: hasInternalScrollContainer,
      },
    );

    await page.waitForTimeout(450);

    if (fingerprint === previousFingerprint) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
    }

    if (stablePasses >= 3) {
      break;
    }

    previousFingerprint = fingerprint;
  }

  await page.evaluate(
    ({ marker, internal }) => {
      const root = internal
        ? document.querySelector<HTMLElement>(`[${marker}="true"]`)
        : document.scrollingElement;

      if (root !== null) {
        root.scrollTop = root.scrollHeight;
      }
    },
    {
      marker: "data-zai-scraper-scroll-root",
      internal: hasInternalScrollContainer,
    },
  );

  await page.waitForTimeout(250);
}

async function countUsableElements(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluateAll((elements, thinkingSelector) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

    const candidates = elements.filter((element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      if (element.closest(thinkingSelector as string)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }

      return normalize(element.innerText).length > 0 || element.querySelector("img, pre, table") !== null;
    });

    return candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) =>
            other !== candidate &&
            other.contains(candidate) &&
            normalize(other.innerText) === normalize(candidate.innerText),
        ),
    ).length;
  }, THINKING_SELECTOR);
}

async function chooseMessageSelector(
  page: Page,
  selectors: readonly string[],
  customSelector: boolean,
): Promise<string> {
  if (customSelector) {
    const selector = selectors[0];

    if (selector === undefined || selector.trim().length === 0) {
      throw new ExtractionError("The custom selector is empty.");
    }

    const count = await countUsableElements(page, selector);

    if (count === 0) {
      throw new ExtractionError(
        `The custom selector ${JSON.stringify(selector)} matched no usable elements.`,
      );
    }

    return selector;
  }

  let best:
    | {
        selector: string;
        count: number;
      }
    | undefined;

  for (const selector of selectors) {
    const count = await countUsableElements(page, selector);

    if (count >= 2) {
      return selector;
    }

    if (count > (best?.count ?? 0)) {
      best = { selector, count };
    }
  }

  if (best !== undefined && best.count > 0) {
    console.warn(`[!] Only one candidate turn was found with ${best.selector}.`);
    return best.selector;
  }

  throw new ExtractionError("Could not identify any usable conversation turns.");
}

async function extractMetadata(page: Page): Promise<Metadata> {
  const metadata = await page.evaluate(() => {
    const meta = (property: string): string | undefined =>
      document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`)?.content.trim() ||
      undefined;

    const canonicalUrl =
      document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href.trim() || undefined;

    return {
      title: meta("og:title") ?? document.title,
      url: meta("og:url") ?? canonicalUrl ?? window.location.href,
    };
  });

  return {
    title: cleanTitle(metadata.title),
    url: metadata.url,
  };
}

async function extractRawTurns(
  page: Page,
  selector: string,
  includeThinking: boolean,
): Promise<RawTurn[]> {
  return page.locator(selector).evaluateAll(
    (elements, options) => {
      type BrowserRole = "User" | "Z.ai";

      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      const thinkingSelector = options.thinkingSelector;

      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };

      const inferRole = (element: HTMLElement): BrowserRole | null => {
        let current: HTMLElement | null = element;

        for (let depth = 0; current !== null && depth < 6; depth += 1) {
          const explicitRole = (
            current.getAttribute("data-message-author-role") ??
            current.getAttribute("data-author") ??
            current.getAttribute("data-role") ??
            ""
          )
            .trim()
            .toLowerCase();

          if (explicitRole === "user" || explicitRole === "human") {
            return "User";
          }

          if (
            explicitRole === "assistant" ||
            explicitRole === "model" ||
            explicitRole === "z.ai" ||
            explicitRole === "zai" ||
            explicitRole === "glm"
          ) {
            return "Z.ai";
          }

          const structuralSignal = [
            current.id,
            typeof current.className === "string" ? current.className : "",
            current.getAttribute("aria-label") ?? "",
          ]
            .join(" ")
            .toLowerCase();

          if (
            current.matches(".user-message, .chat-user") ||
            /(?:user|human)[-_ ]*(?:message|turn|prompt)|(?:message|turn)[-_ ]*(?:user|human)/.test(
              structuralSignal,
            )
          ) {
            return "User";
          }

          if (
            current.matches(
              ".assistant-message, .message-assistant, .chat-message-assistant, .message.assistant",
            ) ||
            /(?:assistant|zai|z-ai|glm|model)[-_ ]*(?:message|turn|response)|(?:message|turn)[-_ ]*(?:assistant|zai|z-ai|glm|model)/.test(
              structuralSignal,
            )
          ) {
            return "Z.ai";
          }

          current = current.parentElement;
        }

        if (element.querySelector(".chat-user, [data-role='user'], [data-message-author-role='user']")) {
          return "User";
        }

        if (
          element.matches(".markdown-prose:not(.chat-user), .markdown-body, .prose, [data-markdown]") ||
          element.querySelector(
            ".markdown-prose:not(.chat-user), [data-role='assistant'], [data-message-author-role='assistant']",
          )
        ) {
          return "Z.ai";
        }

        const firstLine =
          element.innerText
            .split("\n")
            .map((line) => line.trim())
            .find(Boolean) ?? "";

        if (/^(?:user|you|human)\s*:?\s*$/i.test(firstLine)) {
          return "User";
        }

        if (/^(?:z\.ai|zai|assistant|glm)\s*:?\s*$/i.test(firstLine)) {
          return "Z.ai";
        }

        return null;
      };

      const normalizeMath = (root: HTMLElement): void => {
        const katexNodes = Array.from(root.querySelectorAll<HTMLElement>(".katex")).filter(
          (element) => element.parentElement?.closest(".katex") === null,
        );

        for (const katex of katexNodes) {
          const source =
            katex.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ??
            "";

          if (source.length === 0) {
            continue;
          }

          const display = katex.closest(".katex-display") !== null;
          katex.replaceWith(document.createTextNode(display ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`));
        }
      };

      const preserveAttachmentCards = (root: HTMLElement): void => {
        root.querySelectorAll("button").forEach((button) => {
          const text = normalize(button.textContent ?? "");
          const looksLikeAttachment =
            button.querySelector("img[data-cy='image'], img.not-prose, img.object-cover") !== null ||
            (/\.[A-Za-z0-9]{1,10}\b/.test(text) && /\b(?:B|KB|MB|GB|TB)\b/i.test(text));

          if (!looksLikeAttachment) {
            return;
          }

          const replacement = document.createElement("div");
          replacement.setAttribute("data-zai-attachment", "true");
          replacement.innerHTML = button.innerHTML;
          button.replaceWith(replacement);
        });
      };

      const normalizeThinking = (root: HTMLElement): void => {
        const thinkingNodes = Array.from(root.querySelectorAll<HTMLElement>(thinkingSelector)).filter(
          (element) => element.parentElement?.closest(thinkingSelector) === null,
        );

        for (const thinking of thinkingNodes) {
          if (!options.includeThinking) {
            thinking.remove();
            continue;
          }

          const content =
            thinking.querySelector<HTMLElement>('blockquote[slot="content"]') ??
            thinking.querySelector<HTMLElement>("blockquote") ??
            thinking;

          const blockquote = document.createElement("blockquote");
          const label = document.createElement("p");
          const strong = document.createElement("strong");
          strong.textContent = "Thinking";
          label.appendChild(strong);
          blockquote.appendChild(label);

          for (const child of Array.from(content.childNodes)) {
            blockquote.appendChild(child.cloneNode(true));
          }

          thinking.replaceWith(blockquote);
        }
      };

      const candidates = elements.filter((element): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        if (element.closest(thinkingSelector)) {
          return false;
        }

        return (
          isVisible(element) &&
          (normalize(element.innerText).length > 0 || element.querySelector("img, pre, table") !== null)
        );
      });

      const pruned = candidates.filter((candidate) => {
        const candidateText = normalize(candidate.innerText);

        return !candidates.some(
          (other) =>
            other !== candidate &&
            other.contains(candidate) &&
            normalize(other.innerText) === candidateText,
        );
      });

      return pruned.map((element) => {
        const clone = element.cloneNode(true) as HTMLElement;

        preserveAttachmentCards(clone);
        normalizeMath(clone);
        normalizeThinking(clone);

        clone
          .querySelectorAll(
            [
              "script",
              "style",
              "noscript",
              "svg",
              "canvas",
              '[aria-hidden="true"]',
              ".gh-root",
              ".gh-user-query-markdown",
            ].join(", "),
          )
          .forEach((node) => node.remove());

        clone.querySelectorAll("button, [role='button']").forEach((node) => node.remove());

        return {
          role: inferRole(element),
          html: clone.outerHTML,
        };
      });
    },
    {
      includeThinking,
      thinkingSelector: THINKING_SELECTOR,
    },
  );
}

function convertTurns(rawTurns: RawTurn[], converter: TurndownService): Message[] {
  const messages: Message[] = [];
  let expectedRole: Role = "User";

  for (const turn of rawTurns) {
    const currentRole: Role = turn.role ?? expectedRole;
    const markdown = cleanMarkdown(converter.turndown(turn.html), currentRole);

    if (markdown.length === 0) {
      continue;
    }

    const previous = messages.at(-1);

    if (previous?.role === currentRole && previous.content === markdown) {
      expectedRole = currentRole === "User" ? "Z.ai" : "User";
      continue;
    }

    if (previous !== undefined && previous.role === currentRole && turn.role !== null) {
      previous.content = `${previous.content}\n\n${markdown}`;
    } else {
      messages.push({
        role: currentRole,
        content: markdown,
      });
    }

    expectedRole = currentRole === "User" ? "Z.ai" : "User";
  }

  return messages;
}

function formatDocument(metadata: Metadata, messages: Message[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const sections = [
    `# ${metadata.title}`,
    "",
    `**Source:** <${metadata.url}>`,
    `**Scraped:** ${date}`,
    "",
    "---",
    "",
  ];

  for (const message of messages) {
    sections.push(`## ${message.role}`, "", message.content, "");
  }

  return `${sections.join("\n").trimEnd()}\n`;
}

async function writeTextFileAtomic(path: string, content: string): Promise<string> {
  const absolutePath = resolve(path);
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;

  await mkdir(dirname(absolutePath), {
    recursive: true,
  });

  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return absolutePath;
}

async function saveDebugHtml(page: Page, path: string): Promise<void> {
  const outputPath = await writeTextFileAtomic(path, await page.content());
  console.log(`[+] Rendered HTML saved to ${outputPath}`);
}

async function createContext(options: CliOptions): Promise<ContextHandle> {
  const launchOptions = {
    headless: !options.headed,
    locale: "en-US",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  } as const;

  if (options.profileDir !== undefined) {
    const context = await chromium.launchPersistentContext(resolve(options.profileDir), launchOptions);
    return {
      context,
      close: async () => context.close(),
    };
  }

  const browser = await chromium.launch({
    headless: !options.headed,
  });

  const context = await browser.newContext({
    locale: launchOptions.locale,
    extraHTTPHeaders: launchOptions.extraHTTPHeaders,
    ...(options.storageState !== undefined
      ? { storageState: resolve(options.storageState) }
      : {}),
  });

  return {
    context,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

async function validateInputFiles(options: CliOptions): Promise<void> {
  if (options.storageState !== undefined) {
    try {
      await access(resolve(options.storageState));
    } catch (error) {
      throw new UsageError(
        `Storage-state file does not exist or is not readable: ${resolve(options.storageState)}`,
        { cause: error },
      );
    }
  }
}

async function scrapeConversation(options: CliOptions): Promise<ScrapeResult> {
  await validateInputFiles(options);

  console.log(`[-] Launching Chromium in ${options.headed ? "headed" : "headless"} mode`);

  const handle = await createContext(options);
  const { context } = handle;

  await context.route("**/*", async (route) => {
    const resourceType = route.request().resourceType();

    if (resourceType === "font" || resourceType === "media" || resourceType === "image") {
      await route.abort();
      return;
    }

    await route.continue();
  });

  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());
  page.setDefaultTimeout(options.timeoutMs);

  const selectors = options.selector !== undefined ? [options.selector] : MESSAGE_SELECTORS;

  try {
    await navigate(page, options.url, options.timeoutMs);
    await waitForConversationContent(page, selectors, options.url, options.timeoutMs);
    await preloadConversationHistory(page);

    if (options.debugHtml !== undefined) {
      await saveDebugHtml(page, options.debugHtml);
    }

    const selector = await chooseMessageSelector(page, selectors, options.selector !== undefined);

    console.log(`[-] Extracting turns with selector: ${selector}`);

    const [metadata, rawTurns] = await Promise.all([
      extractMetadata(page),
      extractRawTurns(page, selector, options.includeThinking),
    ]);

    console.log(`[-] Detected title: ${metadata.title}`);
    console.log(`[-] Found ${rawTurns.length} raw turn blocks`);

    const messages = convertTurns(rawTurns, configureTurndown());

    if (messages.length === 0) {
      throw new ExtractionError(
        [
          "The page loaded, but no messages could be converted.",
          "Use --debug-html to inspect the rendered DOM or",
          "--selector to provide a message-root selector.",
        ].join(" "),
      );
    }

    const outputPath = options.output ?? `${cleanFilename(metadata.title)}.md`;
    const absoluteOutputPath = await writeTextFileAtomic(
      outputPath,
      formatDocument(metadata, messages),
    );

    if (options.saveStorageState !== undefined) {
      const storageStatePath = resolve(options.saveStorageState);
      await mkdir(dirname(storageStatePath), { recursive: true });
      await context.storageState({ path: storageStatePath });
      console.log(`[+] Storage state saved to ${storageStatePath}`);
    }

    return {
      outputPath: absoluteOutputPath,
      messageCount: messages.length,
      selector,
    };
  } catch (error) {
    if (options.debugHtml !== undefined) {
      await saveDebugHtml(page, options.debugHtml).catch((debugError: unknown) => {
        console.warn(`[!] Could not save debug HTML: ${errorMessage(debugError)}`);
      });
    }

    throw error;
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const result = await scrapeConversation(options);

  console.log(`[+] Saved ${result.messageCount} messages to ${result.outputPath}`);
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`[!] ${error.message}\n`);
    printHelp();
  } else {
    console.error(`[!] ${errorMessage(error)}`);

    if (error instanceof Error && error.cause !== undefined) {
      console.error(`    Caused by: ${errorMessage(error.cause)}`);
    }
  }

  process.exitCode = 1;
});
