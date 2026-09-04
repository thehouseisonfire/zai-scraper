/**
 * Z.ai Conversation Scraper
 *
 * Scrape Z.ai conversations from chat.z.ai and save them as clean Markdown.
 *
 * @example
 * ```ts
 * import { scrapeConversation, parseUrl } from "@thehouseisonfire/zai-conversation-scraper";
 *
 * const result = await scrapeConversation({
 *   url: parseUrl("https://chat.z.ai/s/abc123"),
 *   includeThinking: true,
 * });
 * console.log(`Saved ${result.messageCount} messages to ${result.outputPath}`);
 * ```
 */

// Constants
export {
  /** Default timeout for navigation and content loading (60,000ms). */
  DEFAULT_TIMEOUT_MS,
  /** Default title used when no conversation title is detected. */
  DEFAULT_TITLE,
  /** Current package version. */
  VERSION,
  /** CSS selectors for detecting Z.ai message elements. */
  MESSAGE_SELECTORS,
  /** Regex pattern for stripping Z.ai branding suffixes from titles. */
  TITLE_SUFFIX,
  /** Set of UI noise strings to filter from Markdown content. */
  UI_NOISE,
} from "./zai-to-markdown.ts";

// Error types
export {
  /** Error thrown for invalid command-line usage or input. */
  UsageError,
  /** Error thrown when conversation content cannot be extracted. */
  ExtractionError,
} from "./zai-to-markdown.ts";

// String utilities
export {
  /** Converts a conversation title into a safe filename. */
  cleanFilename,
  /** Cleans Markdown content by removing UI noise. */
  cleanMarkdown,
  /** Cleans a conversation title by removing Z.ai branding suffixes. */
  cleanTitle,
  /** Converts an unknown error value to a string message. */
  errorMessage,
} from "./zai-to-markdown.ts";

// Conversion utilities
export {
  /** Creates and configures a TurndownService for HTML-to-Markdown conversion. */
  configureTurndown,
  /** Converts an API conversation history to an array of Markdown messages. */
  convertApiHistory,
  /** Extracts and converts message content from Z.ai API format to Markdown. */
  extractApiMessageContent,
  /** Formats a complete conversation as a Markdown document. */
  formatDocument,
} from "./zai-to-markdown.ts";

// API utilities
export {
  /** Reconstructs a conversation from captured API responses. */
  conversationFromCapturedResponses,
  /** Merges captured batch API responses into a conversation history. */
  mergeCapturedBatchResponses,
} from "./zai-to-markdown.ts";

// DOM utilities
export {
  /** Prepends turns from a snapshot that are not already in the existing collection. */
  prependUnseenTurns,
} from "./zai-to-markdown.ts";

// CLI utilities
export {
  /** Main entry point for the CLI. */
  main,
  /** Parses command-line arguments into structured options. */
  parseCliOptions,
  /** Parses a string as a positive integer. */
  parsePositiveInteger,
  /** Parses and validates a Z.ai conversation URL. */
  parseUrl,
  /** Prints the command-line help text to stdout. */
  printHelp,
} from "./zai-to-markdown.ts";

// Main scraping function
export {
  /** Scrapes a Z.ai conversation and saves it as a Markdown file. */
  scrapeConversation,
  /** Internal testing utilities - may change in future versions. */
  __testing,
} from "./zai-to-markdown.ts";

// Types
export type {
  /** The role of a message author in a Z.ai conversation. */
  Role,
  /** Metadata about a scraped Z.ai conversation. */
  Metadata,
  /** A raw turn extracted from the DOM before conversion to Markdown. */
  RawTurn,
  /** A message in a Z.ai conversation with converted Markdown content. */
  Message,
  /** Command-line options for scraping a Z.ai conversation. */
  CliOptions,
  /** The result of scraping a Z.ai conversation. */
  ScrapeResult,
  /** Z.ai API conversation history structure. */
  ApiHistory,
  /** A Z.ai conversation as returned by the API. */
  ApiConversation,
  /** A captured HTTP response from Z.ai API endpoints. */
  CapturedHistoryResponse,
} from "./zai-to-markdown.ts";
