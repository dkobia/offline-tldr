// Pure streaming-protocol parsers for the two wire formats local runtimes use:
// NDJSON (Ollama's native API) and SSE (OpenAI-compatible servers).
// They operate on decoded text chunks so they are unit testable without fetch.

/** Decodes a fetch body into text chunks. */
export async function* textChunks(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        yield text;
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Yields one parsed JSON value per newline-delimited line, ignoring blank lines. */
export async function* ndjson(chunks: AsyncIterable<string>): AsyncIterable<unknown> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        yield JSON.parse(line);
      }
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) {
    yield JSON.parse(tail);
  }
}

/**
 * Yields the payload of each SSE `data:` line and stops at the OpenAI
 * `[DONE]` sentinel. Comment lines and other fields are ignored.
 */
export async function* sseData(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice("data:".length).trim();
      if (data === "[DONE]") {
        return;
      }
      if (data.length > 0) {
        yield data;
      }
    }
  }
}
