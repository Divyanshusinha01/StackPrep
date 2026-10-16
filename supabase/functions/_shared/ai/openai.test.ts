import { assert, assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import { z } from "zod";
import { createOpenAIEmbeddingProvider, createOpenAIProvider, createOpenAIWebSearchProvider, toStrictJsonSchema } from "./openai.ts";
import {
  AIAuthError,
  AIInvalidOutputError,
  AIPermissionError,
  AIQuotaError,
  AIRateLimitedError,
  AIRequestError,
  AIUnavailableError,
  assertEmbeddingDimensions,
} from "./provider.ts";

const schema = z.strictObject({ title: z.string().min(1).max(20), count: z.int().min(0) });

const request = {
  model: "gpt-test",
  system: "You are a planner.",
  input: "<repository>hello</repository>",
  schemaName: "test_output",
  schema,
};

function completed(text: string, extra: Record<string, unknown> = {}) {
  return {
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text }] },
    ],
    usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 20 } },
    ...extra,
  };
}

function stub(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  }) as typeof fetch;
  const provider = createOpenAIProvider({ apiKey: "sk-test-key", fetch: fetchFn, retryDelayMs: 0, log: (e) => logs.push(e) });
  return { provider, calls, logs };
}

Deno.test("sends a strict JSON-schema request and returns validated output with usage", async () => {
  const { provider, calls } = stub(() => Response.json(completed(JSON.stringify({ title: "Plan", count: 2 }))));
  const result = await provider.generateStructured(request);
  assertEquals(result, { output: { title: "Plan", count: 2 }, usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } });

  assertEquals(calls[0].url, "https://api.openai.com/v1/responses");
  assertEquals((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-test-key");
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.model, "gpt-test");
  assertEquals(body.instructions, "You are a planner.");
  assertEquals(body.input, [{ role: "user", content: "<repository>hello</repository>" }]);
  assertEquals(body.store, false);
  assertEquals(body.text.format.type, "json_schema");
  assertEquals(body.text.format.name, "test_output");
  assertEquals(body.text.format.strict, true);
  assertEquals(body.text.format.schema.additionalProperties, false);
  assertEquals(body.text.format.schema.required, ["title", "count"]);
});

Deno.test("omits reasoning and verbosity unless requested, and caps output at 16k by default", async () => {
  const { provider, calls } = stub(() => Response.json(completed(JSON.stringify({ title: "Plan", count: 2 }))));
  await provider.generateStructured(request);
  await provider.generateStructured({ ...request, reasoningEffort: "default" });
  for (const call of calls) {
    const body = JSON.parse(call.init.body as string);
    assert(!("reasoning" in body));
    assert(!("verbosity" in body.text));
    assertEquals(body.max_output_tokens, 16_000);
  }
});

Deno.test("sends reasoning effort, verbosity, and the output cap when requested", async () => {
  const { provider, calls } = stub(() => Response.json(completed(JSON.stringify({ title: "Plan", count: 2 }))));
  await provider.generateStructured({ ...request, reasoningEffort: "low", verbosity: "low", maxOutputTokens: 1500 });
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.reasoning, { effort: "low" });
  assertEquals(body.text.verbosity, "low");
  assertEquals(body.text.format.type, "json_schema");
  assertEquals(body.max_output_tokens, 1500);
});

Deno.test("reports reasoning tokens and logs latency without content", async () => {
  const { provider, logs } = stub(() =>
    Response.json(completed(JSON.stringify({ title: "Plan", count: 2 }), {
      usage: { input_tokens: 120, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 } },
    }))
  );
  const { usage } = await provider.generateStructured(request);
  assertEquals(usage, { input_tokens: 120, cached_input_tokens: 0, output_tokens: 30, reasoning_tokens: 12 });
  assertEquals(logs.length, 1);
  const { elapsed_ms, ...rest } = logs[0];
  assertEquals(typeof elapsed_ms, "number");
  assertEquals(rest, {
    event: "ai_call",
    kind: "structured",
    model: "gpt-test",
    schema: "test_output",
    attempt: 1,
    outcome: "ok",
    input_tokens: 120,
    cached_input_tokens: 0,
    output_tokens: 30,
    reasoning_tokens: 12,
  });
  assert(!JSON.stringify(logs).includes("hello"), "logs never carry input");
});

Deno.test("retries an unavailable call up to `retries` times, never other errors", async () => {
  let n = 0;
  const flaky = stub(() => ++n === 1 ? new Response("", { status: 503 }) : Response.json(completed(JSON.stringify({ title: "Ok", count: 1 }))));
  assertEquals((await flaky.provider.generateStructured({ ...request, retries: 1 })).output, { title: "Ok", count: 1 });
  assertEquals(flaky.calls.length, 2);
  assertEquals(flaky.logs.map((l) => [l.attempt, l.outcome, l.retry]), [[1, "AIUnavailableError", true], [2, "ok", undefined]]);

  const down = stub(() => new Response("", { status: 502 }));
  assertInstanceOf(await assertRejects(() => down.provider.generateStructured({ ...request, retries: 1 })), AIUnavailableError);
  assertEquals(down.calls.length, 2);

  const once = stub(() => new Response("", { status: 502 }));
  await assertRejects(() => once.provider.generateStructured(request));
  assertEquals(once.calls.length, 1, "no retry by default");

  for (const status of [400, 429]) {
    const rejected = stub(() => new Response("", { status }));
    await assertRejects(() => rejected.provider.generateStructured({ ...request, retries: 1 }));
    assertEquals(rejected.calls.length, 1, `${status} is not retried`);
  }
});

Deno.test("a per-request timeout aborts a stuck call and the retry gets a fresh one", async () => {
  const signals: AbortSignal[] = [];
  const fetchFn = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      signals.push(init.signal!);
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  const provider = createOpenAIProvider({ apiKey: "k", fetch: fetchFn, retryDelayMs: 0, log: () => {} });
  const started = Date.now();
  assertInstanceOf(await assertRejects(() => provider.generateStructured({ ...request, timeoutMs: 30, retries: 1 })), AIUnavailableError);
  assertEquals(signals.length, 2);
  assert(Date.now() - started < 1_000);
});

Deno.test("the strict JSON schema is built once per schema", () => {
  assert(toStrictJsonSchema(schema) === toStrictJsonSchema(schema));
});

Deno.test("sends images as low-detail input_image parts after the text", async () => {
  const { provider, calls } = stub(() => Response.json(completed(JSON.stringify({ title: "Frame", count: 0 }))));
  const image = "data:image/jpeg;base64,/9j/4AAQ";
  await provider.generateStructured({ ...request, images: [image] });
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.input, [{
    role: "user",
    content: [
      { type: "input_text", text: "<repository>hello</repository>" },
      { type: "input_image", image_url: image, detail: "low" },
    ],
  }]);
  assertEquals(body.store, false);
});

Deno.test("strips schema keywords OpenAI rejects but keeps supported ones", () => {
  const json = JSON.stringify(toStrictJsonSchema(schema));
  for (const keyword of ["$schema", "minLength", "maxLength"]) {
    assert(!json.includes(`"${keyword}"`), `${keyword} should be stripped`);
  }
  assert(json.includes('"minimum"'));
});

Deno.test("maps HTTP failures to typed errors without exposing bodies", async () => {
  const limited = stub(() => new Response("slow down, key sk-test-key", { status: 429, headers: { "Retry-After": "12" } }));
  const e1 = await assertRejects(() => limited.provider.generateStructured(request));
  assertInstanceOf(e1, AIRateLimitedError);
  assertEquals(e1.retryAfterSeconds, 12);
  assert(!e1.message.includes("sk-test-key"));

  const noHeader = stub(() => new Response("", { status: 429 }));
  assertEquals((await assertRejects(() => noHeader.provider.generateStructured(request)) as AIRateLimitedError).retryAfterSeconds, 30);

  const down = stub(() => new Response("bad gateway", { status: 502 }));
  assertInstanceOf(await assertRejects(() => down.provider.generateStructured(request)), AIUnavailableError);

  const rejected = stub(() => new Response("invalid schema", { status: 400 }));
  const e3 = await assertRejects(() => rejected.provider.generateStructured(request));
  assertInstanceOf(e3, AIRequestError);
  assertEquals(e3.status, 400);
  assert(!e3.message.includes("invalid schema"));
});

function openAIError(status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) {
  return () => Response.json({ error: { message: "Incorrect API key provided: sk-test-key", ...error } }, { status, headers });
}

Deno.test("classifies key failures from the error code and type only", async () => {
  const auth = await assertRejects(() => stub(openAIError(401, { code: "invalid_api_key" })).provider.generateStructured(request));
  assertInstanceOf(auth, AIAuthError);
  assertInstanceOf(auth, AIRequestError);

  const quota = await assertRejects(() =>
    stub(openAIError(429, { code: "insufficient_quota", type: "insufficient_quota" })).provider.generateStructured(request)
  );
  assertInstanceOf(quota, AIQuotaError);

  const denied = await assertRejects(() => stub(openAIError(403, { code: null })).provider.generateStructured(request));
  assertInstanceOf(denied, AIPermissionError);
  assertEquals(denied.reason, "permission_denied");

  const missingModel = await assertRejects(() => stub(openAIError(404, { code: "model_not_found" })).provider.generateStructured(request));
  assertInstanceOf(missingModel, AIPermissionError);
  assertEquals(missingModel.reason, "model_unavailable");

  const limited = await assertRejects(() =>
    stub(openAIError(429, { code: "rate_limit_exceeded" }, { "Retry-After": "4" })).provider.generateStructured(request)
  );
  assertInstanceOf(limited, AIRateLimitedError);
  assertEquals(limited.retryAfterSeconds, 4);

  for (const err of [auth, quota, denied, missingModel, limited]) {
    assert(!err.message.includes("sk-test-key"));
    assert(!err.message.includes("Incorrect"));
  }
});

Deno.test("embedding key failures use the same taxonomy", async () => {
  const fetchFn = (() => Promise.resolve(openAIError(401, { code: "invalid_api_key" })())) as typeof fetch;
  const provider = createOpenAIEmbeddingProvider({ apiKey: "sk-test-key", fetch: fetchFn, log: () => {} });
  assertInstanceOf(await assertRejects(() => provider.embed({ model: "e", input: ["x"] })), AIAuthError);
});

Deno.test("network errors and timeouts are unavailable", async () => {
  const fetchFn = (() => Promise.reject(new TypeError("connection reset"))) as typeof fetch;
  const provider = createOpenAIProvider({ apiKey: "k", fetch: fetchFn });
  assertInstanceOf(await assertRejects(() => provider.generateStructured(request)), AIUnavailableError);
});

Deno.test("refusals, incomplete responses, and invalid output are invalid output", async () => {
  const cases: [unknown, string][] = [
    [{ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }, "refusal"],
    [completed('{"title": "Pl', { status: "incomplete" }), "incomplete"],
    [completed("not json"), "malformed"],
    [completed(JSON.stringify({ title: "", count: 1 })), "schema_mismatch"],
    [completed(JSON.stringify({ title: "x".repeat(50), count: 1 })), "schema_mismatch"],
    [{ unexpected: true }, "malformed"],
  ];
  for (const [body, reason] of cases) {
    const { provider } = stub(() => Response.json(body));
    const err = await assertRejects(() => provider.generateStructured(request));
    assertInstanceOf(err, AIInvalidOutputError);
    assertEquals(err.reason, reason);
  }
});

// Embeddings ---------------------------------------------------------------------------------

function embeddingStub(respond: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(init));
  }) as typeof fetch;
  return { provider: createOpenAIEmbeddingProvider({ apiKey: "sk-test-key", fetch: fetchFn }), calls };
}

function embeddingBody(vectors: [number, number[]][], promptTokens = 9) {
  return {
    object: "list",
    data: vectors.map(([index, embedding]) => ({ object: "embedding", index, embedding })),
    model: "text-embedding-3-small",
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

Deno.test("embeddings: sends float encoding without dimensions and returns vectors in input order", async () => {
  const { provider, calls } = embeddingStub(() => Response.json(embeddingBody([[1, [0.3, 0.4]], [0, [0.1, 0.2]]], 12)));
  const result = await provider.embed({ model: "text-embedding-3-small", input: ["first", "second"] });
  assertEquals(result, { embeddings: [[0.1, 0.2], [0.3, 0.4]], usage: { input_tokens: 12 } });

  assertEquals(calls[0].url, "https://api.openai.com/v1/embeddings");
  assertEquals((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-test-key");
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body, { model: "text-embedding-3-small", input: ["first", "second"], encoding_format: "float" });
  assert(!("dimensions" in body), "native dimensions are never truncated");
});

Deno.test("embeddings: missing usage counts as zero tokens", async () => {
  const { provider } = embeddingStub(() => Response.json({ data: [{ index: 0, embedding: [1] }] }));
  assertEquals((await provider.embed({ model: "m", input: ["x"] })).usage, { input_tokens: 0 });
});

Deno.test("embeddings: a caller abort cancels the request and is unavailable", async () => {
  const controller = new AbortController();
  const fetchFn = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  const provider = createOpenAIEmbeddingProvider({ apiKey: "k", fetch: fetchFn });
  const pending = provider.embed({ model: "m", input: ["x"], signal: controller.signal });
  controller.abort();
  assertInstanceOf(await assertRejects(() => pending), AIUnavailableError);
});

Deno.test("embeddings: HTTP and network failures map to typed errors without exposing bodies", async () => {
  const request = { model: "m", input: ["x"] };
  const limited = embeddingStub(() => new Response("slow down sk-test-key", { status: 429, headers: { "Retry-After": "7" } }));
  const e1 = await assertRejects(() => limited.provider.embed(request));
  assertInstanceOf(e1, AIRateLimitedError);
  assertEquals(e1.retryAfterSeconds, 7);
  assert(!e1.message.includes("sk-test-key"));

  const down = embeddingStub(() => new Response("bad gateway", { status: 503 }));
  assertInstanceOf(await assertRejects(() => down.provider.embed(request)), AIUnavailableError);

  const rejected = embeddingStub(() => new Response("bad model", { status: 400 }));
  const e3 = await assertRejects(() => rejected.provider.embed(request));
  assertInstanceOf(e3, AIRequestError);
  assert(!e3.message.includes("bad model"));

  const offline = createOpenAIEmbeddingProvider({ apiKey: "k", fetch: (() => Promise.reject(new TypeError("reset"))) as typeof fetch });
  assertInstanceOf(await assertRejects(() => offline.embed(request)), AIUnavailableError);
});

Deno.test("embeddings: a wrong count, duplicate index, or malformed body is malformed output", async () => {
  const bodies: unknown[] = [
    embeddingBody([[0, [1]]]),
    embeddingBody([[0, [1]], [0, [2]]]),
    embeddingBody([[0, [1]], [2, [2]]]),
    { data: [{ index: 0, embedding: ["x"] }, { index: 1, embedding: [1] }] },
    { unexpected: true },
  ];
  for (const body of bodies) {
    const { provider } = embeddingStub(() => Response.json(body));
    const err = await assertRejects(() => provider.embed({ model: "m", input: ["a", "b"] }));
    assertInstanceOf(err, AIInvalidOutputError);
    assertEquals(err.reason, "malformed");
  }
});

Deno.test("embedding dimensions must match exactly and be finite", () => {
  assertEmbeddingDimensions([[0.1, 0.2, 0.3]], 3);
  for (const vectors of [[[0.1, 0.2]], [new Array(3072).fill(0.1)], [[0.1, Number.NaN, 0.3]], [[0.1, Infinity, 0.3]]]) {
    const err = assertThrows(() => assertEmbeddingDimensions(vectors, 3));
    assertInstanceOf(err, AIInvalidOutputError);
    assertEquals(err.reason, "dimension_mismatch");
  }
});


function searchStub(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  }) as typeof fetch;
  return { provider: createOpenAIWebSearchProvider({ apiKey: "sk-test-key", fetch: fetchFn, log: (e) => logs.push(e) }), calls, logs };
}

const searchRequest = { model: "gpt-search", system: "Find docs.", input: "Concept: http caching", maxToolCalls: 2 };

function searchResponse(status = "completed") {
  const text = "MDN explains Cache-Control. (mdn)\nThe RFC defines semantics. (rfc) See also https://evil.example/typed.";
  const at = (marker: string) => ({ start_index: text.indexOf(marker), end_index: text.indexOf(marker) + marker.length });
  return {
    status,
    output: [
      { type: "web_search_call", id: "ws_1", status: "completed" },
      { type: "web_search_call", id: "ws_2", status: "completed" },
      {
        type: "message",
        content: [{
          type: "output_text",
          text,
          annotations: [
            { type: "url_citation", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching", title: "HTTP caching - MDN", ...at("(mdn)") },
            { type: "url_citation", url: "https://www.rfc-editor.org/rfc/rfc9111", title: "RFC 9111", ...at("(rfc)") },
            { type: "file_citation", file_id: "f" },
          ],
        }],
      },
    ],
    usage: { input_tokens: 300, output_tokens: 80 },
  };
}

Deno.test("web search sends the web_search tool and returns only annotated citations", async () => {
  const { provider, calls, logs } = searchStub(() => Response.json(searchResponse()));
  const result = await provider.searchWeb(searchRequest);

  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.tools, [{ type: "web_search" }]);
  assertEquals([body.tool_choice, body.max_tool_calls, body.store], ["required", 2, false]);
  assertEquals(body.input, [{ role: "user", content: "Concept: http caching" }]);
  assertEquals((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-test-key");

  assertEquals(result.citations.map((c) => c.url), [
    "https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching",
    "https://www.rfc-editor.org/rfc/rfc9111",
  ], "URLs typed in the answer text are ignored");
  assertEquals(result.citations[0].excerpt, "MDN explains Cache-Control.");
  assertEquals(result.citations[1].excerpt, "The RFC defines semantics.");
  assertEquals(result.searchCalls, 2);
  assertEquals(result.usage, { input_tokens: 300, cached_input_tokens: 0, output_tokens: 80 });

  const logged = JSON.stringify(logs);
  assert(!logged.includes("http caching") && !logged.includes("https://"), "queries and URLs are never logged");
});

Deno.test("web search maps incomplete output and HTTP errors like structured calls", async () => {
  await assertRejects(() => searchStub(() => Response.json(searchResponse("incomplete"))).provider.searchWeb(searchRequest), AIInvalidOutputError);
  await assertRejects(
    () => searchStub(() => Response.json({ error: { code: "invalid_api_key" } }, { status: 401 })).provider.searchWeb(searchRequest),
    AIAuthError,
  );
  await assertRejects(() => searchStub(() => new Response("", { status: 503 })).provider.searchWeb(searchRequest), AIUnavailableError);
});