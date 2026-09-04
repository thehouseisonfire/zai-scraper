import assert from "node:assert/strict";
import { describe, test } from "node:test";

// This test verifies basic library functionality works at runtime
// It exercises the exported API without requiring actual browser/scraping

import {
  VERSION,
  cleanFilename,
  cleanMarkdown,
  cleanTitle,
  DEFAULT_TITLE,
  DEFAULT_TIMEOUT_MS,
  MESSAGE_SELECTORS,
  TITLE_SUFFIX,
  UI_NOISE,
  UsageError,
  ExtractionError,
  errorMessage,
  parsePositiveInteger,
  parseUrl,
  configureTurndown,
  convertApiHistory,
  formatDocument,
  type Metadata,
  type RawTurn,
  type Message,
  type Role,
  type CliOptions,
  type ScrapeResult,
  type ApiHistory,
  type ApiConversation,
  type CapturedHistoryResponse,
} from "./index.ts";

describe("Runtime smoke test", () => {
  test("all exports are available", () => {
    // Constants
    assert.equal(typeof DEFAULT_TIMEOUT_MS, "number");
    assert.equal(typeof DEFAULT_TITLE, "string");
    assert.equal(typeof VERSION, "string");
    assert.equal(Array.isArray(MESSAGE_SELECTORS), true);
    assert.equal(TITLE_SUFFIX instanceof RegExp, true);
    assert.equal(UI_NOISE instanceof Set, true);

    // Error classes
    assert.equal(typeof UsageError, "function");
    assert.equal(typeof ExtractionError, "function");

    // Functions
    assert.equal(typeof cleanFilename, "function");
    assert.equal(typeof cleanMarkdown, "function");
    assert.equal(typeof cleanTitle, "function");
    assert.equal(typeof errorMessage, "function");
    assert.equal(typeof parsePositiveInteger, "function");
    assert.equal(typeof parseUrl, "function");
    assert.equal(typeof configureTurndown, "function");
    assert.equal(typeof convertApiHistory, "function");
    assert.equal(typeof formatDocument, "function");
  });

  test("types are properly exported", () => {
    // Type exports are checked at compile time, but we can verify
    // the values are available at runtime by using them in type annotations
    const role: Role = "User";
    const metadata: Metadata = { title: "Test", url: "https://test.com" };
    const rawTurn: RawTurn = { key: "test", role: null, html: "<p>test</p>" };
    const message: Message = { role: "User", content: "test" };
    const cliOptions: CliOptions = {
      url: new URL("https://test.com"),
      timeoutMs: 60000,
      headed: false,
      includeThinking: false,
    };
    const scrapeResult: ScrapeResult = {
      outputPath: "/test.md",
      messageCount: 1,
      selector: ".test",
    };
    const apiHistory: ApiHistory = {
      currentId: null,
      messages: {},
    };
    const apiConversation: ApiConversation = {
      history: apiHistory,
    };
    const capturedResponse: CapturedHistoryResponse = {
      url: "https://test.com",
      method: "GET",
      status: 200,
      body: "",
      data: null,
    };

    assert.equal(role, "User");
    assert.equal(metadata.title, "Test");
    assert.equal(rawTurn.html, "<p>test</p>");
    assert.equal(message.content, "test");
    assert.equal(cliOptions.timeoutMs, 60000);
    assert.equal(scrapeResult.messageCount, 1);
    assert.equal(apiHistory.currentId, null);
    assert.equal(apiConversation.history, apiHistory);
    assert.equal(capturedResponse.url, "https://test.com");
  });

  test("library functions work correctly", () => {
    assert.equal(cleanTitle("Test | Z.ai"), "Test");
    assert.equal(cleanFilename("Test File"), "Test_File");
    assert.equal(cleanMarkdown("Hello\nCopy\nWorld", "User"), "Hello\nWorld");
    assert.equal(parsePositiveInteger("42", "--timeout"), 42);
    assert.equal(parseUrl("https://chat.z.ai/s/test").protocol, "https:");
    assert.equal(errorMessage(new Error("test")), "test");
  });

  test("Turndown configuration works", () => {
    const converter = configureTurndown();
    assert.equal(typeof converter.turndown, "function");
    const result = converter.turndown("<p>Hello</p>");
    assert.match(result, /Hello/);
  });

  test("convertApiHistory works", () => {
    const converter = configureTurndown();
    const apiHistory: ApiHistory = {
      currentId: "a1",
      messages: {
        u1: { id: "u1", parentId: null, role: "user", content: "Question" },
        a1: {
          id: "a1",
          parentId: "u1",
          role: "assistant",
          content_blocks: [{ type: "text", text: "Answer" }],
        },
      },
    };
    const messages = convertApiHistory(apiHistory, converter, false);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "User");
    assert.match(messages[0]?.content ?? "", /Question/);
    assert.equal(messages[1]?.role, "Z.ai");
    assert.match(messages[1]?.content ?? "", /Answer/);
  });

  test("formatDocument works", () => {
    const metadata: Metadata = {
      title: "Test Conversation",
      url: "https://chat.z.ai/test",
    };
    const messages: Message[] = [
      { role: "User", content: "Hello" },
      { role: "Z.ai", content: "Hi there" },
    ];
    const result = formatDocument(metadata, messages);
    assert.match(result, /# Test Conversation/);
    assert.match(result, /https:\/\/chat\.z\.ai\/test/);
    assert.match(result, /## User/);
    assert.match(result, /Hello/);
    assert.match(result, /## Z\.ai/);
    assert.match(result, /Hi there/);
  });
});
