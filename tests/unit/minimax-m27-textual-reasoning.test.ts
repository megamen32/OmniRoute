import assert from "node:assert/strict";
import test from "node:test";
import {
  isNativeMiniMaxM27Route,
  sanitizeOpenAIResponse,
  shouldParseTextualReasoningTags,
} from "../../open-sse/handlers/responseSanitizer.ts";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.ts";

const model = "MiniMax-M2.7";
const toolCall = {
  index: 0,
  id: "call_synthetic_m27",
  type: "function",
  function: { name: "probe", arguments: '{"value":"<think>literal</think>"}' },
};
const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };

async function stream(deltas: Array<Record<string, unknown>>, finish = "tool_calls") {
  const events = [
    ...deltas.map((delta) => ({ delta, finish_reason: null })),
    { delta: {}, finish_reason: finish },
  ];
  const wire =
    events
      .map(
        (entry, i) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-fixture",
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, ...entry }],
            ...(i === events.length - 1 ? { usage } : {}),
          })}\n\n`
      )
      .join("") + "data: [DONE]\n\n";
  const output = await new Response(
    new Response(wire).body!.pipeThrough(
      createPassthroughStreamWithLogger("minimax", null, null, model)
    )
  ).text();
  const chunks = output
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  const choices = chunks.flatMap((chunk) => chunk.choices ?? []);
  return {
    content: choices.map((choice) => choice.delta?.content ?? "").join(""),
    reasoning: choices.map((choice) => choice.delta?.reasoning_content ?? "").join(""),
    calls: choices.flatMap((choice) => choice.delta?.tool_calls ?? []),
    functions: choices.flatMap((choice) => choice.delta?.function_call ?? []),
    finish: choices.find((choice) => choice.finish_reason)?.finish_reason,
    usage: chunks.findLast((chunk) => chunk.usage)?.usage,
  };
}

test("MiniMax M2.7 single SSE delta separates reasoning, answer and exactly one tool call", async () => {
  const output = await stream([
    {
      role: "assistant",
      content: "<think>synthetic thought</think>answer",
      tool_calls: [toolCall],
    },
  ]);
  assert.equal(output.content, "answer");
  assert.equal(output.reasoning, "synthetic thought");
  assert.deepEqual(output.calls, [toolCall]);
  assert.equal(output.finish, "tool_calls");
  assert.equal(output.usage.total_tokens, 30);
});

test("MiniMax M2.7 handles split markers with reasoning and a tool before any answer", async () => {
  const output = await stream([
    { role: "assistant", content: "<th" },
    { content: "ink>synthetic " },
    { content: "thought</thi" },
    { content: "nk>", tool_calls: [toolCall] },
  ]);
  assert.equal(output.content, "");
  assert.equal(output.reasoning, "synthetic thought");
  assert.deepEqual(output.calls, [toolCall]);
});

test("MiniMax M2.7 reasoning event does not repeat already structured tool data", async () => {
  const output = await stream([
    {
      role: "assistant",
      content: "answer",
      reasoning_content: "native",
      tool_calls: [toolCall],
      function_call: { name: "probe", arguments: "{}" },
    },
  ]);
  assert.equal(output.reasoning, "native");
  assert.deepEqual(output.calls, [toolCall]);
  assert.equal(output.functions.length, 1);
});

test("MiniMax M2.7 keeps structured reasoning and preserves fenced or inline tag examples", async () => {
  const literal = "```xml\n<think>literal</think>\n```";
  const output = await stream(
    [{ content: literal }, { content: " use `<think>example</think>`" }],
    "stop"
  );
  assert.equal(output.content, literal + " use `<think>example</think>`");
  assert.equal(output.reasoning, "");
  const both = await stream([
    { content: "<think>native</think>answer", reasoning_content: "native", tool_calls: [toolCall] },
  ]);
  assert.equal(both.content, "answer");
  assert.equal(both.reasoning, "native");
});

test("MiniMax M2.7 JSON separates leading reasoning with a tool, preserving tag examples and usage", () => {
  const parseTextualReasoningTags = shouldParseTextualReasoningTags("minimax", model);
  assert.equal(parseTextualReasoningTags, true);
  const literal = "```xml\n<think>example</think>\n```";
  for (const [content, answer, reasoning] of [
    ["<think>synthetic thought</think>", "", "synthetic thought"],
    ["<think>synthetic thought</think>answer", "answer", "synthetic thought"],
    [literal, literal, undefined],
    ["See <think>literal</think>.", "See <think>literal</think>.", undefined],
  ] as const) {
    const body = sanitizeOpenAIResponse(
      {
        model,
        usage,
        choices: [
          {
            finish_reason: "tool_calls",
            message: { role: "assistant", content, tool_calls: [toolCall] },
          },
        ],
      },
      { parseTextualReasoningTags: isNativeMiniMaxM27Route("minimax", model) ? "leading" : true }
    );
    const message = (body.choices as Array<{ message: Record<string, unknown> }>)[0].message;
    assert.equal(message.content, answer);
    assert.equal(message.reasoning_content, reasoning);
    assert.deepEqual(message.tool_calls, [toolCall]);
    assert.deepEqual(body.usage, usage);
  }
});
