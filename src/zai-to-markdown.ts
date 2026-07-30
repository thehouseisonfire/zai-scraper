#!/usr/bin/env bun

import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { chromium, errors as playwrightErrors, type BrowserContext, type Page } from "playwright";
import TurndownService from "turndown";
import turndownPluginGfm from "turndown-plugin-gfm";

type Role = "User" | "Z.ai";

interface Metadata {
  title: string;
  url: string;
}

interface RawTurn {
  key: string;
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

interface PageJsonResponse {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
  error: string | null;
}

interface ApiHistory {
  currentId: string | null;
  messages: Record<string, Record<string, unknown>>;
}

interface ApiConversation {
  title?: string;
  history: ApiHistory;
}

interface ApiScrapeResult {
  metadata: Metadata;
  messages: Message[];
  endpoint: string;
  historyMessageCount: number;
  branchMessageCount: number;
  branchComplete: boolean;
}

interface ApiEnrichmentResult {
  requestEndpoint: string | null;
  branchComplete: boolean;
}

interface CapturedHistoryResponse {
  url: string;
  method: string;
  status: number;
  body: string;
  data: unknown;
}

interface HistoryCapture {
  readonly entries: CapturedHistoryResponse[];
  waitForIdle(): Promise<void>;
  dispose(): void;
}

const DEFAULT_TITLE = "Z.ai Conversation";
const DEFAULT_TIMEOUT_MS = 60_000;
const ZAI_HOSTNAMES = new Set(["chat.z.ai", "www.chat.z.ai"]);

const TITLE_SUFFIX =
  /\s*(?:\||-|—)\s*(?:Z\.ai|ZAI|Chat Z\.ai)(?:\s*-\s*Advanced AI Chatbot[^|]*)?\s*$/i;
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
  "#chat-container [data-message-author-role]",
  '#chat-container [data-role="user"], #chat-container [data-role="assistant"]',
  "#chat-container .user-message, #chat-container .assistant-message",
  "#chat-container .chat-user, #chat-container .markdown-prose:not(.chat-user)",
  "#chat-container .message-user, #chat-container .message-assistant",
  "#chat-container .chat-message-user, #chat-container .chat-message-assistant",
  "#chat-container article",
  "#chat-container .prose",
] as const;

const CONVERSATION_CONTENT_SELECTOR = [
  '#chat-container [id^="message-"]',
  "#chat-container .chat-user",
  "#chat-container .markdown-prose:not(.chat-user)",
  "#chat-container [data-message-author-role]",
  '#chat-container [data-role="user"]',
  '#chat-container [data-role="assistant"]',
].join(", ");


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
    throw new UsageError("Expected a Z.ai conversation URL with /c/<id> or /s/<id> in its path.");
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
    ...(values["storage-state"] !== undefined ? { storageState: values["storage-state"] } : {}),
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

  const looksLikeAuthentication =
    /\b(?:sign in|log in|login|continue with google|verify email)\b/i.test(state.bodyText);

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function createHistoryCapture(page: Page): HistoryCapture {
  const entries: CapturedHistoryResponse[] = [];
  const pending = new Set<Promise<void>>();

  const onResponse = (response: import("playwright").Response): void => {
    const request = response.request();
    let url: URL;

    try {
      url = new URL(response.url());
    } catch {
      return;
    }

    const hostname = url.hostname.toLowerCase();

    if (hostname !== "z.ai" && !hostname.endsWith(".z.ai")) {
      return;
    }

    const path = url.pathname.toLowerCase();
    const relevant =
      path.includes("/api/") &&
      /(?:chat|conversation|history|message|share|batch)/i.test(path);

    if (!relevant || response.status() < 200 || response.status() >= 300) {
      return;
    }

    const task = (async () => {
      try {
        const body = await response.text();

        if (body.trim().length === 0) {
          return;
        }

        let data: unknown = body;

        try {
          data = JSON.parse(body) as unknown;
        } catch {
          // Some deployments label JSON as text/plain. Keep the raw body for
          // diagnostics, but only JSON payloads participate in API extraction.
        }

        entries.push({
          url: response.url(),
          method: request.method(),
          status: response.status(),
          body,
          data,
        });
      } catch {
        // Response bodies can become unavailable after redirects or page close.
      }
    })();

    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  page.on("response", onResponse);

  return {
    entries,
    async waitForIdle(): Promise<void> {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
    dispose(): void {
      page.off("response", onResponse);
    },
  };
}

function mergeCapturedBatchResponses(
  history: ApiHistory,
  entries: readonly CapturedHistoryResponse[],
): number {
  const before = Object.keys(history.messages).length;

  for (const entry of entries) {
    let pathname = "";

    try {
      pathname = new URL(entry.url).pathname;
    } catch {
      continue;
    }

    if (!/\/messages\/batch(?:\/|$)/i.test(pathname)) {
      continue;
    }

    const payload = asRecord(entry.data);
    const messages = normalizeApiMessageMap(payload?.data ?? entry.data);
    mergeApiMessages(history, messages);
  }

  return Object.keys(history.messages).length - before;
}

function conversationFromCapturedResponses(
  entries: readonly CapturedHistoryResponse[],
): { conversation: ApiConversation; endpoint: string } | null {
  for (const entry of [...entries].reverse()) {
    const conversation = parseApiConversation(entry.data);

    if (conversation !== undefined) {
      mergeCapturedBatchResponses(conversation.history, entries);
      return { conversation, endpoint: entry.url };
    }
  }

  const history: ApiHistory = { currentId: null, messages: {} };
  mergeCapturedBatchResponses(history, entries);

  if (Object.keys(history.messages).length === 0) {
    return null;
  }

  return {
    conversation: { history },
    endpoint: entries.find((entry) => /\/messages\/batch(?:\/|$)/i.test(entry.url))?.url ??
      "captured Z.ai history responses",
  };
}

async function scrollEveryHistorySurfaceToTop(page: Page): Promise<boolean> {
  const scrolled = await page
    .evaluate(() => {
      const elements = [document.scrollingElement, ...Array.from(document.querySelectorAll("*"))];
      let foundScrollable = false;

      for (const element of elements) {
        if (!(element instanceof HTMLElement)) {
          continue;
        }

        if (element.scrollHeight <= element.clientHeight + 40) {
          continue;
        }

        foundScrollable = true;
        element.scrollTo({ top: 0, behavior: "auto" });
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      }

      window.scrollTo({ top: 0, behavior: "auto" });
      window.dispatchEvent(new Event("scroll"));
      return foundScrollable;
    })
    .catch(() => false);

  await page.locator("#chat-container").hover().catch(() => undefined);
  await page.mouse.wheel(0, -100_000).catch(() => undefined);
  await page.keyboard.press("Home").catch(() => undefined);
  return scrolled;
}

async function hydrateHistoryFromCapturedTraffic(
  page: Page,
  capture: HistoryCapture,
  history: ApiHistory,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stablePasses = 0;
  let previousEntryCount = -1;
  let previousMessageCount = -1;

  while (!isApiBranchComplete(history) && Date.now() < deadline && stablePasses < 4) {
    await capture.waitForIdle();
    mergeCapturedBatchResponses(history, capture.entries);

    const entryCount = capture.entries.length;
    const messageCount = Object.keys(history.messages).length;

    if (entryCount === previousEntryCount && messageCount === previousMessageCount) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
    }

    previousEntryCount = entryCount;
    previousMessageCount = messageCount;

    await scrollEveryHistorySurfaceToTop(page);
    await page.waitForTimeout(650);
  }

  await capture.waitForIdle();
  mergeCapturedBatchResponses(history, capture.entries);
  return isApiBranchComplete(history);
}

async function fetchPageJson(
  page: Page,
  endpoint: string,
  init?: {
    method?: "GET" | "POST";
    body?: unknown;
  },
): Promise<PageJsonResponse> {
  return page.evaluate(
    async ({ url, method, body }): Promise<PageJsonResponse> => {
      try {
        const response = await fetch(url, {
          method,
          credentials: "include",
          headers: {
            accept: "application/json",
            ...(body === null ? {} : { "content-type": "application/json" }),
          },
          ...(body === null ? {} : { body: JSON.stringify(body) }),
        });

        const text = await response.text();
        let data: unknown = null;

        if (text.length > 0) {
          try {
            data = JSON.parse(text) as unknown;
          } catch {
            data = text;
          }
        }

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          data,
          error: null,
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          statusText: "",
          data: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      url: endpoint,
      method: init?.method ?? "GET",
      body: init?.body ?? null,
    },
  );
}

function normalizeApiMessageMap(value: unknown): Record<string, Record<string, unknown>> {
  const output: Record<string, Record<string, unknown>> = {};

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = asRecord(item);
      const id = message === undefined ? undefined : firstString(message, ["id", "message_id"]);

      if (message !== undefined && id !== undefined) {
        output[id] = { ...message, id };
      }
    }

    return output;
  }

  const record = asRecord(value);

  if (record === undefined) {
    return output;
  }

  for (const [key, item] of Object.entries(record)) {
    const message = asRecord(item);

    if (message === undefined) {
      continue;
    }

    const id = firstString(message, ["id", "message_id"]) ?? key;
    output[id] = { ...message, id };
  }

  return output;
}

function parseApiConversation(payload: unknown): ApiConversation | undefined {
  const root = asRecord(payload);

  if (root === undefined) {
    return undefined;
  }

  const data = asRecord(root.data);
  const candidates = [
    root,
    data,
    asRecord(root.chat),
    data === undefined ? undefined : asRecord(data.chat),
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== undefined);

  let historyRecord: Record<string, unknown> | undefined;

  for (const candidate of candidates) {
    const possibleHistory = asRecord(candidate.history);

    if (possibleHistory !== undefined && possibleHistory.messages !== undefined) {
      historyRecord = possibleHistory;
      break;
    }
  }

  if (historyRecord === undefined) {
    return undefined;
  }

  const messages = normalizeApiMessageMap(historyRecord.messages);
  const currentId = firstString(historyRecord, ["currentId", "current_id"]);

  // Some Z.ai responses expose only currentId initially. The active branch can
  // still be hydrated by requesting that message and following parentId links.
  if (Object.keys(messages).length === 0 && currentId === undefined) {
    return undefined;
  }

  const title =
    firstString(root, ["title", "name"]) ??
    (data === undefined ? undefined : firstString(data, ["title", "name"])) ??
    candidates.map((candidate) => firstString(candidate, ["title", "name"])).find(Boolean);

  return {
    ...(title === undefined ? {} : { title }),
    history: {
      currentId: currentId ?? null,
      messages,
    },
  };
}

function messageParentId(message: Record<string, unknown>): string | null {
  const value = message.parentId ?? message.parent_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function messageChildrenIds(message: Record<string, unknown>): string[] {
  const value = message.childrenIds ?? message.children_ids;

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function messageTimestamp(message: Record<string, unknown>): number {
  const value = message.timestamp ?? message.created_at ?? message.createdAt;

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

function chooseApiLeaf(history: ApiHistory): string | undefined {
  if (history.currentId !== null && history.messages[history.currentId] !== undefined) {
    return history.currentId;
  }

  const entries = Object.entries(history.messages);
  const leaves = entries.filter(([, message]) =>
    messageChildrenIds(message).every((childId) => history.messages[childId] === undefined),
  );
  const candidates = leaves.length > 0 ? leaves : entries;

  candidates.sort((left, right) => messageTimestamp(right[1]) - messageTimestamp(left[1]));
  return candidates[0]?.[0];
}

function activeApiBranchIds(history: ApiHistory): string[] {
  const leaf = chooseApiLeaf(history);

  if (leaf === undefined) {
    return [];
  }

  const reversed: string[] = [];
  const seen = new Set<string>();
  let currentId: string | null = leaf;

  while (currentId !== null && !seen.has(currentId)) {
    const message = history.messages[currentId];

    if (message === undefined) {
      break;
    }

    reversed.push(currentId);
    seen.add(currentId);
    currentId = messageParentId(message);
  }

  return reversed.reverse();
}

function hasApiMessageContent(message: Record<string, unknown>): boolean {
  const content = message.content;

  if (typeof content === "string" && content.trim().length > 0) {
    return true;
  }

  if (Array.isArray(content) && content.length > 0) {
    return true;
  }

  for (const key of ["content_blocks", "contentBlocks", "blocks"] as const) {
    if (Array.isArray(message[key]) && message[key].length > 0) {
      return true;
    }
  }

  return Array.isArray(message.files) && message.files.length > 0;
}

function mergeApiMessages(
  history: ApiHistory,
  messages: Record<string, Record<string, unknown>>,
): void {
  for (const [id, message] of Object.entries(messages)) {
    history.messages[id] = {
      ...history.messages[id],
      ...message,
      id,
    };
  }
}

async function fetchApiMessageBatch(
  page: Page,
  conversationId: string,
  ids: readonly string[],
): Promise<{
  endpoint: string;
  messages: Record<string, Record<string, unknown>>;
} | null> {
  if (ids.length === 0) {
    return null;
  }

  // The chat-scoped endpoint is used by the current Z.ai web client. The
  // unscoped form is retained as a compatibility fallback for deployments
  // that expose the same batch handler at /api/v1/messages/batch.
  const endpoints = [
    `/api/v1/chats/${encodeURIComponent(conversationId)}/messages/batch`,
    "/api/v1/messages/batch",
  ] as const;

  for (const endpoint of endpoints) {
    const response = await fetchPageJson(page, endpoint, {
      method: "POST",
      body: { ids },
    });

    if (!response.ok) {
      continue;
    }

    const payload = asRecord(response.data);
    const messages = normalizeApiMessageMap(payload?.data ?? response.data);

    if (Object.keys(messages).length > 0) {
      return { endpoint, messages };
    }
  }

  return null;
}

function isApiBranchComplete(history: ApiHistory): boolean {
  const branch = activeApiBranchIds(history);
  const oldestId = branch[0];

  if (oldestId === undefined) {
    return false;
  }

  return messageParentId(history.messages[oldestId] ?? {}) === null;
}

async function enrichApiMessages(
  page: Page,
  conversationId: string,
  history: ApiHistory,
): Promise<ApiEnrichmentResult> {
  let requestEndpoint: string | null = null;

  const fetchAndMerge = async (ids: readonly string[]): Promise<boolean> => {
    const uniqueIds = Array.from(new Set(ids.filter((id) => id.length > 0)));

    if (uniqueIds.length === 0) {
      return false;
    }

    const result = await fetchApiMessageBatch(page, conversationId, uniqueIds);

    if (result === null) {
      return false;
    }

    requestEndpoint = result.endpoint;
    mergeApiMessages(history, result.messages);
    return true;
  };

  // Hydrate all references already exposed by metadata in bounded batches.
  const knownIds = Object.keys(history.messages);
  const incompleteKnownIds = knownIds.filter(
    (id) => !hasApiMessageContent(history.messages[id] ?? {}),
  );

  for (let offset = 0; offset < incompleteKnownIds.length; offset += 100) {
    const chunk = incompleteKnownIds.slice(offset, offset + 100);

    if (!(await fetchAndMerge(chunk))) {
      console.warn(
        "[!] Z.ai message batch request failed; attempting to reconstruct the branch from the metadata already available.",
      );
      break;
    }
  }

  // The initial history may contain only the newest page, or even only
  // currentId. Follow parentId and fetch missing ancestors until reaching the
  // root. This avoids depending on DOM virtualization or scroll behavior.
  let currentId = chooseApiLeaf(history) ?? history.currentId;
  const visited = new Set<string>();

  for (let depth = 0; currentId !== null && depth < 10_000; depth += 1) {
    if (visited.has(currentId)) {
      console.warn(`[!] Detected a cycle in Z.ai history at message ${currentId}.`);
      break;
    }

    visited.add(currentId);
    let message = history.messages[currentId];

    if (message === undefined || !hasApiMessageContent(message)) {
      await fetchAndMerge([currentId]);
      message = history.messages[currentId];
    }

    if (message === undefined) {
      console.warn(`[!] Could not load Z.ai history message ${currentId}.`);
      break;
    }

    const parentId = messageParentId(message);

    if (parentId === null) {
      break;
    }

    if (history.messages[parentId] === undefined) {
      const loaded = await fetchAndMerge([parentId]);

      if (!loaded || history.messages[parentId] === undefined) {
        console.warn(`[!] Could not load older Z.ai history before message ${currentId}.`);
        break;
      }
    }

    currentId = parentId;
  }

  return {
    requestEndpoint,
    branchComplete: isApiBranchComplete(history),
  };
}

function contentPartToMarkdown(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => contentPartToMarkdown(item, depth + 1))
      .filter((item) => item.trim().length > 0)
      .join("\n\n");
  }

  const record = asRecord(value);

  if (record === undefined) {
    return "";
  }

  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const text = record.text;

  if (typeof text === "string") {
    return text;
  }

  const textRecord = asRecord(text);
  const textValue =
    textRecord === undefined ? undefined : firstString(textRecord, ["value", "content"]);

  if (textValue !== undefined) {
    return textValue;
  }

  if (type.includes("image")) {
    const image = asRecord(record.image_url ?? record.imageUrl);
    const url =
      (typeof record.url === "string" ? record.url : undefined) ??
      (image === undefined ? undefined : firstString(image, ["url"])) ??
      "";

    return url.length > 0 ? `![](${url})` : "";
  }

  for (const key of [
    "content",
    "value",
    "message",
    "output",
    "parts",
    "body",
    "markdown",
  ] as const) {
    if (record[key] !== undefined && record[key] !== value) {
      const nested = contentPartToMarkdown(record[key], depth + 1);

      if (nested.trim().length > 0) {
        return nested;
      }
    }
  }

  return "";
}

function apiAttachmentMarkdown(message: Record<string, unknown>): string[] {
  if (!Array.isArray(message.files)) {
    return [];
  }

  const output: string[] = [];
  const seen = new Set<string>();

  for (const value of message.files) {
    const file = asRecord(value);

    if (file === undefined) {
      continue;
    }

    const nestedFile = asRecord(file.file);
    const meta = nestedFile === undefined ? undefined : asRecord(nestedFile.meta);
    const name =
      firstString(file, ["name", "filename", "id"]) ??
      (nestedFile === undefined
        ? undefined
        : firstString(nestedFile, ["filename", "name", "id"])) ??
      (meta === undefined ? undefined : firstString(meta, ["name", "filename"])) ??
      "attachment";
    const url =
      firstString(file, ["url", "src", "cdn_url"]) ??
      (meta === undefined ? undefined : firstString(meta, ["cdn_url", "url"])) ??
      "";
    const mediaType =
      firstString(file, ["media", "type", "content_type"]) ??
      (meta === undefined ? undefined : firstString(meta, ["content_type", "type"])) ??
      "";
    const key = `${name}\u0000${url}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const isImage =
      /image/i.test(mediaType) || /\.(?:png|jpe?g|gif|webp|avif|svg)(?:$|[?#])/i.test(url || name);

    if (url.length > 0) {
      output.push(isImage ? `![${name}](${url})` : `[${name}](${url})`);
    } else {
      output.push(`**Attachment:** ${name}`);
    }
  }

  return output;
}

function extractEmbeddedThinking(markdown: string): {
  body: string;
  thinking: string[];
} {
  const thinking: string[] = [];
  let body = markdown.replace(
    /<think(?:\s[^>]*)?>([\s\S]*?)<\/think>/gi,
    (_match, content: string) => {
      const cleaned = content.trim();

      if (cleaned.length > 0) {
        thinking.push(cleaned);
      }

      return "";
    },
  );

  body = body.replace(
    /<details\b[^>]*(?:type=["']?(?:reasoning|thinking)["']?|class=["'][^"']*(?:reasoning|thinking)[^"']*["'])[^>]*>([\s\S]*?)<\/details>/gi,
    (_match, content: string) => {
      const cleaned = content
        .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, "")
        .replace(/<[^>]+>/g, "")
        .trim();

      if (cleaned.length > 0) {
        thinking.push(cleaned);
      }

      return "";
    },
  );

  return { body, thinking };
}

function formatThinkingBlock(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").trim().split("\n");
  return [
    "> **Thinking**",
    ">",
    ...lines.map((line) => (line.length > 0 ? `> ${line}` : ">")),
  ].join("\n");
}

function apiMessageRole(message: Record<string, unknown>): Role | undefined {
  const author = asRecord(message.author);
  const sender = asRecord(message.sender);
  const rawRole = (
    firstString(message, ["role", "author", "sender", "sender_role", "senderRole"]) ??
    (author === undefined ? undefined : firstString(author, ["role", "type", "name"])) ??
    (sender === undefined ? undefined : firstString(sender, ["role", "type", "name"]))
  )?.toLowerCase();

  if (rawRole === "user" || rawRole === "human") {
    return "User";
  }

  if (rawRole === "assistant" || rawRole === "model" || rawRole === "zai" || rawRole === "z.ai") {
    return "Z.ai";
  }

  return undefined;
}

function uniqueMarkdownFragments(values: readonly string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = value.trim();

    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function apiAssistantContentBlocks(message: Record<string, unknown>): unknown[] {
  for (const key of ["content_blocks", "contentBlocks", "blocks"] as const) {
    const value = message[key];

    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
  }

  return [];
}

function extractApiMessageContent(
  message: Record<string, unknown>,
  role: Role,
): { body: string; thinking: string[] } {
  const fallbackBody = contentPartToMarkdown(message.content);

  if (role === "User") {
    return { body: fallbackBody, thinking: [] };
  }

  const bodyParts: string[] = [];
  const thinkingParts: string[] = [];

  for (const block of apiAssistantContentBlocks(message)) {
    const record = asRecord(block);
    const signal =
      record === undefined
        ? ""
        : [
            firstString(record, ["type", "block_type", "blockType"]),
            firstString(record, ["phase", "stage"]),
          ]
            .filter((value): value is string => value !== undefined)
            .join(" ")
            .toLowerCase();
    const markdown = contentPartToMarkdown(block).trim();

    if (markdown.length === 0) {
      continue;
    }

    if (/(?:reasoning|thinking|analysis|thought)/i.test(signal)) {
      thinkingParts.push(markdown);
      continue;
    }

    if (/(?:tool|function|search|citation|reference|attachment|file|image)/i.test(signal)) {
      continue;
    }

    bodyParts.push(markdown);
  }

  return {
    body: uniqueMarkdownFragments(bodyParts).join("\n\n") || fallbackBody,
    thinking: uniqueMarkdownFragments(thinkingParts),
  };
}

function countApiBranchRoles(history: ApiHistory): {
  users: number;
  assistants: number;
  assistantsWithVisibleContent: number;
} {
  let users = 0;
  let assistants = 0;
  let assistantsWithVisibleContent = 0;

  for (const id of activeApiBranchIds(history)) {
    const message = history.messages[id];
    const role = message === undefined ? undefined : apiMessageRole(message);

    if (role === "User") {
      users += 1;
    } else if (role === "Z.ai" && message !== undefined) {
      assistants += 1;

      const body = extractApiMessageContent(message, role).body.trim();

      if (body.length > 0 || apiAttachmentMarkdown(message).length > 0) {
        assistantsWithVisibleContent += 1;
      }
    }
  }

  return { users, assistants, assistantsWithVisibleContent };
}

function convertApiHistory(
  history: ApiHistory,
  converter: TurndownService,
  includeThinking: boolean,
): Message[] {
  const output: Message[] = [];

  for (const id of activeApiBranchIds(history)) {
    const message = history.messages[id];

    if (message === undefined) {
      continue;
    }

    const role = apiMessageRole(message);

    if (role === undefined) {
      continue;
    }

    const extracted = extractApiMessageContent(message, role);
    const embedded = extractEmbeddedThinking(extracted.body);
    const body = embedded.body;

    const explicitThinking = contentPartToMarkdown(
      message.reasoning_content ??
        message.reasoningContent ??
        message.reasoning ??
        message.thinking,
    );
    const thinking = uniqueMarkdownFragments([
      ...extracted.thinking,
      ...embedded.thinking,
      explicitThinking,
    ]);

    const attachments = apiAttachmentMarkdown(message);
    const sections = [
      ...(includeThinking ? thinking.map(formatThinkingBlock) : []),
      body,
      ...attachments.filter((attachment) => !body.includes(attachment)),
    ].filter((section) => section.trim().length > 0);

    let markdown = sections.join("\n\n");

    if (/<(?:p|div|pre|table|h[1-6]|ul|ol|blockquote)\b/i.test(markdown)) {
      markdown = converter.turndown(markdown);
    }

    markdown = cleanMarkdown(markdown, role);

    if (markdown.length === 0) {
      continue;
    }

    const previous = output.at(-1);

    if (previous !== undefined && previous.role === role) {
      previous.content = `${previous.content}\n\n${markdown}`;
    } else {
      output.push({ role, content: markdown });
    }
  }

  return output;
}

async function tryExtractConversationFromApi(
  page: Page,
  requestedUrl: URL,
  includeThinking: boolean,
  capture: HistoryCapture,
  timeoutMs: number,
): Promise<ApiScrapeResult | null> {
  const match = requestedUrl.pathname.match(/^\/(c|s)\/([^/]+)/i);

  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }

  const kind = match[1].toLowerCase();
  const conversationId = match[2];
  const endpoint =
    kind === "s"
      ? `/api/v1/chats/share/${encodeURIComponent(conversationId)}`
      : `/api/v1/chats/${encodeURIComponent(conversationId)}`;

  console.log("[-] Inspecting history responses loaded by the Z.ai page");

  await page
    .locator(CONVERSATION_CONTENT_SELECTOR)
    .first()
    .waitFor({ state: "attached", timeout: Math.min(timeoutMs, 10_000) })
    .catch(() => undefined);
  await page.waitForTimeout(150);
  await capture.waitForIdle();

  let captured = conversationFromCapturedResponses(capture.entries);
  let directEndpointStatus: PageJsonResponse | null = null;

  if (captured === null) {
    console.log(`[-] No usable captured history yet; trying ${endpoint}`);
    directEndpointStatus = await fetchPageJson(page, endpoint);

    if (directEndpointStatus.ok) {
      const conversation = parseApiConversation(directEndpointStatus.data);
      if (conversation !== undefined) {
        captured = { conversation, endpoint };
      }
    }
  }

  if (captured === null) {
    console.warn(
      `[!] No usable Z.ai history response was captured${
        directEndpointStatus === null
          ? ""
          : `; direct history request returned ${directEndpointStatus.status || "a network error"}${
              directEndpointStatus.statusText ? ` ${directEndpointStatus.statusText}` : ""
            }`
      }. Falling back to incremental rendered-DOM collection.`,
    );
    return null;
  }

  const { conversation } = captured;
  console.log(`[-] Using ${capture.entries.length} successful history response(s) loaded by the page`);
  await hydrateHistoryFromCapturedTraffic(page, capture, conversation.history, timeoutMs);
  const enrichment = await enrichApiMessages(page, conversationId, conversation.history);
  mergeCapturedBatchResponses(conversation.history, capture.entries);

  const converter = configureTurndown();
  const branchIds = activeApiBranchIds(conversation.history);
  const branchRoles = countApiBranchRoles(conversation.history);
  const messages = convertApiHistory(conversation.history, converter, includeThinking);
  const exportedAssistantCount = messages.filter((message) => message.role === "Z.ai").length;

  if (messages.length === 0) {
    console.warn(
      "[!] Z.ai history API contained no convertible active-branch messages; falling back to the DOM.",
    );
    return null;
  }

  if (branchRoles.assistantsWithVisibleContent > 0 && exportedAssistantCount === 0) {
    console.warn(
      "[!] Z.ai history contained assistant records, but none could be decoded; falling back to rendered-DOM extraction instead of silently exporting user-only history.",
    );
    return null;
  }

  const pageMetadata = await extractMetadata(page);
  const historyMessageCount = Object.keys(conversation.history.messages).length;

  return {
    metadata: {
      title: cleanTitle(conversation.title ?? pageMetadata.title),
      url: pageMetadata.url || requestedUrl.href,
    },
    messages,
    endpoint: enrichment.requestEndpoint ?? captured.endpoint,
    historyMessageCount,
    branchMessageCount: branchIds.length,
    branchComplete: enrichment.branchComplete,
  };
}

function prependUnseenTurns(existing: RawTurn[], snapshot: RawTurn[]): RawTurn[] {
  const seen = new Set(existing.map((turn) => turn.key));
  const unseen = snapshot.filter((turn) => !seen.has(turn.key));
  return unseen.length === 0 ? existing : [...unseen, ...existing];
}

async function collectRawTurnsIncrementally(
  page: Page,
  selector: string,
  includeThinking: boolean,
  timeoutMs: number,
): Promise<RawTurn[]> {
  const deadline = Date.now() + timeoutMs;
  let collected = await extractRawTurns(page, selector, includeThinking);
  let stablePasses = 0;

  while (Date.now() < deadline && stablePasses < 4) {
    const before = collected.length;
    await scrollEveryHistorySurfaceToTop(page);
    await page.waitForTimeout(650);

    const snapshot = await extractRawTurns(page, selector, includeThinking);
    collected = prependUnseenTurns(collected, snapshot);

    if (collected.length === before) {
      stablePasses += 1;
    } else {
      stablePasses = 0;
      console.log(`[-] Collected ${collected.length} distinct rendered turn blocks so far`);
    }
  }

  return collected;
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

      return (
        normalize(element.innerText).length > 0 || element.querySelector("img, pre, table") !== null
      );
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

        if (
          element.querySelector(".chat-user, [data-role='user'], [data-message-author-role='user']")
        ) {
          return "User";
        }

        if (
          element.matches(
            ".markdown-prose:not(.chat-user), .markdown-body, .prose, [data-markdown]",
          ) ||
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
          katex.replaceWith(
            document.createTextNode(display ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`),
          );
        }
      };

      const preserveAttachmentCards = (root: HTMLElement): void => {
        root.querySelectorAll("button").forEach((button) => {
          const text = normalize(button.textContent ?? "");
          const looksLikeAttachment =
            button.querySelector("img[data-cy='image'], img.not-prose, img.object-cover") !==
              null ||
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
        const thinkingNodes = Array.from(
          root.querySelectorAll<HTMLElement>(thinkingSelector),
        ).filter((element) => element.parentElement?.closest(thinkingSelector) === null);

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
          (normalize(element.innerText).length > 0 ||
            element.querySelector("img, pre, table") !== null)
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

        const role = inferRole(element);
        const closestMessage = element.closest('[id^="message-"]');
        const explicitId =
          element.id || (closestMessage instanceof HTMLElement ? closestMessage.id : "");
        const textKey = normalize(element.innerText).slice(0, 500);

        return {
          key: explicitId || `${role ?? "unknown"}:${textKey}`,
          role,
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
    const context = await chromium.launchPersistentContext(
      resolve(options.profileDir),
      launchOptions,
    );
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
    ...(options.storageState !== undefined ? { storageState: resolve(options.storageState) } : {}),
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
  const historyCapture = createHistoryCapture(page);

  const selectors = options.selector !== undefined ? [options.selector] : MESSAGE_SELECTORS;

  try {
    await navigate(page, options.url, options.timeoutMs);

    const apiResult =
      options.selector === undefined
        ? await tryExtractConversationFromApi(
            page,
            options.url,
            options.includeThinking,
            historyCapture,
            options.timeoutMs,
          )
        : null;

    if (apiResult === null) {
      await waitForConversationContent(page, selectors, options.url, options.timeoutMs);
    }

    let metadata: Metadata;
    let messages: Message[];
    let selector: string;

    if (apiResult !== null) {
      metadata = apiResult.metadata;
      messages = apiResult.messages;
      selector = apiResult.endpoint;

      console.log(`[-] Detected title: ${metadata.title}`);
      console.log(
        `[-] Loaded ${messages.length} exported messages from ${apiResult.branchMessageCount} active-branch records (${apiResult.historyMessageCount} API records cached)`,
      );

      if (!apiResult.branchComplete) {
        console.warn(
          "[!] The API branch did not reach a root message; the export may still be incomplete.",
        );
      }
    } else {
      selector = await chooseMessageSelector(page, selectors, options.selector !== undefined);
      console.log(`[-] Collecting rendered turns incrementally with selector: ${selector}`);

      const [domMetadata, rawTurns] = await Promise.all([
        extractMetadata(page),
        collectRawTurnsIncrementally(page, selector, options.includeThinking, options.timeoutMs),
      ]);

      metadata = domMetadata;
      console.log(`[-] Detected title: ${metadata.title}`);
      console.log(`[-] Collected ${rawTurns.length} distinct raw turn blocks`);

      messages = convertTurns(rawTurns, configureTurndown());
    }

    if (options.debugHtml !== undefined) {
      await saveDebugHtml(page, options.debugHtml);
    }

    if (messages.length === 0) {
      throw new ExtractionError(
        [
          "The page loaded, but no messages could be converted.",
          "Use --debug-html to inspect the rendered DOM or",
          "--selector to force a message-root selector.",
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
    historyCapture.dispose();
    await handle.close();
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const result = await scrapeConversation(options);

  console.log(`[+] Saved ${result.messageCount} messages to ${result.outputPath}`);
}

export const __testing = {
  configureTurndown,
  convertApiHistory,
  extractApiMessageContent,
  mergeCapturedBatchResponses,
  conversationFromCapturedResponses,
  prependUnseenTurns,
};

const isMainModule =
  import.meta.main ||
  (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMainModule) {
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
}
