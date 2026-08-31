import { describe, expect, it } from "vitest";
import { ndjson, sseData, textChunks } from "./stream";

async function* chunks(...parts: string[]): AsyncIterable<string> {
  for (const part of parts) {
    yield part;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

describe("ndjson", () => {
  it("parses one JSON value per line", async () => {
    const result = await collect(ndjson(chunks('{"a":1}\n{"b":2}\n')));
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles lines split across chunks", async () => {
    const result = await collect(ndjson(chunks('{"mess', 'age":"hi"}\n{"done"', ":true}\n")));
    expect(result).toEqual([{ message: "hi" }, { done: true }]);
  });

  it("parses a trailing line without a final newline and skips blank lines", async () => {
    const result = await collect(ndjson(chunks('{"a":1}\n\n\n{"b":2}')));
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("sseData", () => {
  it("yields data payloads and stops at [DONE]", async () => {
    const stream = chunks(
      'data: {"x":1}\n\n',
      ': keep-alive comment\n',
      'data: {"x":2}\n\n',
      "data: [DONE]\n\n",
      'data: {"x":3}\n\n',
    );
    expect(await collect(sseData(stream))).toEqual(['{"x":1}', '{"x":2}']);
  });

  it("handles CRLF line endings and events split across chunks", async () => {
    const stream = chunks('data: {"a"', ':1}\r\ndata: {"b":2}\r\n');
    expect(await collect(sseData(stream))).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("textChunks", () => {
  it("decodes a byte stream including multi-byte characters split across reads", async () => {
    const bytes = new TextEncoder().encode("héllo wörld");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2)); // splits the é sequence
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });
    expect((await collect(textChunks(stream))).join("")).toBe("héllo wörld");
  });
});
