import test from "node:test";
import assert from "node:assert/strict";

async function loadGateway() {
  return import("../../open-sse/executors/minimaxCodeGateway.ts");
}

test("gateway payload maps system, user and assistant turns", async () => {
  const { buildGatewayPayload } = await loadGateway();
  const payload = buildGatewayPayload(
    {
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "What time is it?" },
        { role: "assistant", content: "Checking." },
        { role: "user", content: "Thanks." },
      ],
    },
    "MiniMax-M3.1-Flash"
  );
  assert.equal(payload.model, "MiniMax-M3.1-Flash");
  assert.equal(payload.system, "You are a coding assistant.");
  assert.equal(payload.messages.length, 3);
  assert.equal(payload.messages[0].role, "user");
  assert.equal(payload.messages[0].content, "What time is it?");
  assert.equal(payload.messages[1].role, "assistant");
  assert.equal(payload.messages[2].content, "Thanks.");
  assert.equal(payload.tools, undefined);
});

test("gateway payload maps OpenAI tools to Anthropic input_schema", async () => {
  const { buildGatewayPayload } = await loadGateway();
  const payload = buildGatewayPayload(
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_time",
            description: "Current time in a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
    },
    "MiniMax-M3.1-Flash"
  );
  assert.equal(Array.isArray(payload.tools), true);
  const tool = (payload.tools as Record<string, unknown>[])[0];
  assert.equal(tool.name, "get_time");
  assert.equal(tool.description, "Current time in a city");
  assert.deepEqual(tool.input_schema, {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  });
});

test("gateway payload carries assistant tool calls and tool results", async () => {
  const { buildGatewayPayload } = await loadGateway();
  const payload = buildGatewayPayload(
    {
      messages: [
        { role: "user", content: "Weather in Moscow?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_time", arguments: '{"city":"Moscow"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "get_time", content: "12:00" },
      ],
    },
    "MiniMax-M3.1-Flash"
  );
  const assistant = payload.messages[1] as { role: string; content: Record<string, unknown>[] };
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content[0].type, "tool_use");
  assert.equal(assistant.content[0].id, "call_1");
  assert.equal(assistant.content[0].name, "get_time");
  assert.deepEqual(assistant.content[0].input, { city: "Moscow" });

  const toolTurn = payload.messages[2] as { role: string; content: Record<string, unknown>[] };
  assert.equal(toolTurn.role, "user");
  assert.equal(toolTurn.content[0].type, "tool_result");
  assert.equal(toolTurn.content[0].tool_use_id, "call_1");
  assert.equal(toolTurn.content[0].content, "12:00");
});

test("gateway payload drops tools when tool_choice is none", async () => {
  const { buildGatewayPayload } = await loadGateway();
  const payload = buildGatewayPayload(
    {
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "none",
      tools: [
        {
          type: "function",
          function: { name: "get_time", description: "d", parameters: { type: "object" } },
        },
      ],
    },
    "MiniMax-M3.1-Flash"
  );
  assert.equal(payload.tools, undefined);
});

test("gateway result is parsed into text and tool calls", async () => {
  const { parseGatewayResult } = await loadGateway();
  const result = parseGatewayResult({
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "call_5e", name: "get_time", input: { city: "Москва" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 42, output_tokens: 7 },
  });
  assert.equal(result.text, "Let me check.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "get_time");
  assert.deepEqual(result.toolCalls[0].input, { city: "Москва" });
  assert.equal(result.stopReason, "tool_use");
  assert.equal(result.inputTokens, 42);
  assert.equal(result.outputTokens, 7);
});

test("gateway result becomes an OpenAI completion with tool_calls", async () => {
  const { parseGatewayResult, gatewayResultToCompletion } = await loadGateway();
  const result = parseGatewayResult({
    content: [
      { type: "text", text: "Checking" },
      { type: "tool_use", id: "call_5e", name: "get_time", input: { city: "Москва" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 42, output_tokens: 7 },
  });
  const body = gatewayResultToCompletion("MiniMax-M3.1-Flash", result);
  const choice = (body.choices as Record<string, unknown>[])[0];
  const message = choice.message as Record<string, unknown>;
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(message.content, "Checking");
  const calls = message.tool_calls as Record<string, unknown>[];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "call_5e");
  assert.equal(calls[0].type, "function");
  const fn = calls[0].function as Record<string, unknown>;
  assert.equal(fn.name, "get_time");
  assert.deepEqual(JSON.parse(String(fn.arguments)), { city: "Москва" });
  const usage = body.usage as Record<string, number>;
  assert.equal(usage.prompt_tokens, 42);
  assert.equal(usage.completion_tokens, 7);
  assert.equal(usage.total_tokens, 49);
});

test("gateway stream events accumulate text and tool arguments", async () => {
  const { applyGatewayEvent, parseGatewaySse } = await loadGateway();
  const state = {
    text: "",
    toolCalls: [],
    finishReason: "end_turn",
    inputTokens: 0,
    outputTokens: 0,
  };
  const frames = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"get_time"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"Moscow\\"}"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
  ].join("");
  let deltas = "";
  for (const event of parseGatewaySse(frames)) deltas += applyGatewayEvent(state, event);
  assert.equal(deltas, "Hi");
  assert.equal(state.text, "Hi");
  assert.equal(state.inputTokens, 11);
  assert.equal(state.outputTokens, 5);
  assert.equal(state.finishReason, "tool_use");
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].name, "get_time");
  assert.deepEqual(JSON.parse(state.toolCalls[0].arguments), { city: "Moscow" });
});

test("auth profile path honours the explicit override", async () => {
  const { resolveAuthFile } = await loadGateway();
  const previous = process.env.MINIMAX_CODE_AUTH_FILE;
  process.env.MINIMAX_CODE_AUTH_FILE = "/tmp/custom-auth.json";
  try {
    assert.equal(resolveAuthFile(), "/tmp/custom-auth.json");
  } finally {
    if (previous === undefined) delete process.env.MINIMAX_CODE_AUTH_FILE;
    else process.env.MINIMAX_CODE_AUTH_FILE = previous;
  }
});
