/** Fetching and minimal shape check of an Agent Card. */

/** Cards larger than this are refused. */
export const MAX_CARD_BYTES = 64 * 1024;
/** A fetch taking longer than this is aborted. */
export const FETCH_TIMEOUT_MS = 10_000;

/** Thrown when an Agent Card cannot be fetched within the limits. */
export class CardFetchError extends Error {
  override name = "CardFetchError";
}

export interface FetchCardOptions {
  /** Allow `http:` URLs. Only for tests against a local server. */
  allowHttp?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  fetcher?: typeof fetch;
}

/**
 * Fetch the exact bytes at `agentUri`. HTTPS only, no redirects, at most
 * `maxBytes`, within `timeoutMs`. The bytes are returned as-is so they can be
 * hashed.
 */
export async function fetchCard(agentUri: string, options: FetchCardOptions = {}): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? MAX_CARD_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;

  let url: URL;
  try {
    url = new URL(agentUri);
  } catch {
    throw new CardFetchError("agent_uri is not a valid URL");
  }
  const httpAllowed = options.allowHttp === true && url.protocol === "http:";
  if (url.protocol !== "https:" && !httpAllowed) {
    throw new CardFetchError(`only https agent_uri is fetched, not ${url.protocol}`);
  }

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetcher(url, {
      redirect: "error",
      signal,
      headers: { accept: "application/json" },
    });
    if (response.status !== 200) {
      throw new CardFetchError(`agent_uri answered HTTP ${String(response.status)}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      throw new CardFetchError(`card is larger than ${String(maxBytes)} bytes`);
    }
    if (response.body === null) {
      return new Uint8Array(0);
    }
    // A fetch Response body is a byte stream; the Node typings say `any`.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CardFetchError(`card is larger than ${String(maxBytes)} bytes`);
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof CardFetchError) {
      throw error;
    }
    if (signal.aborted) {
      throw new CardFetchError(`fetching the card took longer than ${String(timeoutMs)} ms`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new CardFetchError(`fetching the card failed: ${reason}`);
  }
}

export interface CardShape {
  ok: boolean;
  name: string | null;
  problems: string[];
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Minimal shape check: UTF-8 JSON, a top-level object, and a non-empty
 * string `name`. The spec gives no further rules, so none are invented here.
 */
export function checkCardShape(bytes: Uint8Array): CardShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(bytes));
  } catch {
    return { ok: false, name: null, problems: ["card is not UTF-8 JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, name: null, problems: ["card is not a JSON object"] };
  }
  const name = (parsed as Record<string, unknown>)["name"];
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, name: null, problems: ["card has no non-empty string \"name\""] };
  }
  return { ok: true, name, problems: [] };
}
