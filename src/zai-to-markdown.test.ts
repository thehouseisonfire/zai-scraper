import { describe, expect, test } from "bun:test";

import { __testing } from "./zai-to-markdown.ts";

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

describe("captured Z.ai history traffic", () => {
  test("reconstructs history from page-loaded metadata and batch responses", () => {
    const captured = __testing.conversationFromCapturedResponses([
      {
        url: "https://chat.z.ai/api/v1/chats/share/example",
        method: "GET",
        status: 200,
        body: "",
        data: {
          title: "Captured conversation",
          chat: {
            history: {
              currentId: "a1",
              messages: {
                u1: { id: "u1", parentId: null, role: "user" },
                a1: { id: "a1", parentId: "u1", role: "assistant" },
              },
            },
          },
        },
      },
      {
        url: "https://chat.z.ai/api/v1/chats/example/messages/batch",
        method: "POST",
        status: 200,
        body: "",
        data: {
          data: {
            u1: { id: "u1", parentId: null, role: "user", content: "Question" },
            a1: {
              id: "a1",
              parentId: "u1",
              role: "assistant",
              content_blocks: [{ type: "text", text: "Answer" }],
            },
          },
        },
      },
    ]);

    expect(captured?.conversation.title).toBe("Captured conversation");
    expect(
      __testing.convertApiHistory(
        captured!.conversation.history,
        __testing.configureTurndown(),
        false,
      ),
    ).toEqual([
      { role: "User", content: "Question" },
      { role: "Z.ai", content: "Answer" },
    ]);
  });

  test("prepends older virtualized DOM windows without losing the latest turns", () => {
    const latest = [
      { key: "message-u2", role: "User" as const, html: "<div>Question 2</div>" },
      { key: "message-a2", role: "Z.ai" as const, html: "<div>Answer 2</div>" },
    ];
    const older = [
      { key: "message-u1", role: "User" as const, html: "<div>Question 1</div>" },
      { key: "message-a1", role: "Z.ai" as const, html: "<div>Answer 1</div>" },
      latest[0]!,
    ];

    expect(__testing.prependUnseenTurns(latest, older).map((turn) => turn.key)).toEqual([
      "message-u1",
      "message-a1",
      "message-u2",
      "message-a2",
    ]);
  });
});
