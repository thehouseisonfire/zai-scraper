import { describe, expect, test } from "bun:test";

import { __testing } from "./zai-to-markdown";

function historyWithAssistantBlocks() {
  return {
    currentId: "u2",
    messages: {
      u1: {
        id: "u1",
        parentId: null,
        role: "user",
        content: "First question",
      },
      a1: {
        id: "a1",
        parentId: "u1",
        role: "assistant",
        content: "",
        content_blocks: [
          { type: "reasoning", text: "Internal reasoning" },
          { type: "text", text: "First answer" },
        ],
      },
      u2: {
        id: "u2",
        parentId: "a1",
        role: "user",
        content: "Second question",
      },
    },
  };
}

describe("Z.ai API history conversion", () => {
  test("decodes assistant content_blocks between user messages", () => {
    const messages = __testing.convertApiHistory(
      historyWithAssistantBlocks(),
      __testing.configureTurndown(),
      false,
    );

    expect(messages).toEqual([
      { role: "User", content: "First question" },
      { role: "Z.ai", content: "First answer" },
      { role: "User", content: "Second question" },
    ]);
  });

  test("includes reasoning blocks only when requested", () => {
    const messages = __testing.convertApiHistory(
      historyWithAssistantBlocks(),
      __testing.configureTurndown(),
      true,
    );

    expect(messages[1]).toEqual({
      role: "Z.ai",
      content: "> **Thinking**\n>\n> Internal reasoning\n\nFirst answer",
    });
  });

  test("reads roles and assistant text from nested API records", () => {
    const messages = __testing.convertApiHistory(
      {
        currentId: "a1",
        messages: {
          u1: {
            id: "u1",
            parentId: null,
            author: { role: "user" },
            content: "Question",
          },
          a1: {
            id: "a1",
            parentId: "u1",
            author: { role: "assistant" },
            content_blocks: [{ type: "text", text: { content: "Nested answer" } }],
          },
        },
      },
      __testing.configureTurndown(),
      false,
    );

    expect(messages).toEqual([
      { role: "User", content: "Question" },
      { role: "Z.ai", content: "Nested answer" },
    ]);
  });

  test("falls back to assistant content when content_blocks are absent", () => {
    const messages = __testing.convertApiHistory(
      {
        currentId: "a1",
        messages: {
          u1: { id: "u1", parentId: null, role: "user", content: "Question" },
          a1: { id: "a1", parentId: "u1", role: "assistant", content: "Answer" },
        },
      },
      __testing.configureTurndown(),
      false,
    );

    expect(messages).toEqual([
      { role: "User", content: "Question" },
      { role: "Z.ai", content: "Answer" },
    ]);
  });
});
