/**
 * Shared helpers for talking to ESPN's fantasy football API.
 *
 * This module is intentionally pure - no imports from `./_generated/api` or
 * any other `convex/*.ts` module that itself references `internal`. Every
 * call site in `espnSync.ts` imports this module as a plain value; if it
 * pulled in `internal` transitively, the generated `api` type would become
 * recursive (TS7022/7023) and large parts of the Convex function tree would
 * silently collapse to `any`. Keep it that way: types and `fetch` only.
 *
 * Every ESPN read in this codebase goes through the same
 * `lm-api-reads.fantasy.espn.com` host with the same browser-shaped header
 * block, previously copy-pasted at every call site (see the audit that
 * produced this file). `buildEspnHeaders` is the one place that header block
 * lives now; `fetchEspn` is the one place retry/backoff behavior lives.
 */

/** Raw, unnormalized ESPN session credentials as stored or submitted by a user. */
export interface RawEspnCredentials {
  espnS2?: string;
  swid?: string;
}

/** Normalized ESPN session credentials, ready to build a `Cookie` header from. */
export interface EspnCredentials {
  espnS2?: string;
  swid?: string;
  /** True only when both `espnS2` and `swid` are present after normalization. */
  hasCredentials: boolean;
}

/**
 * Normalize a commissioner-supplied (or previously-stored) espn_s2/SWID pair.
 *
 * - Trims both values.
 * - Decodes `espnS2` exactly once, and only when it looks URL-encoded (contains
 *   a `%`). A value that is already decoded has no `%` in practice, so this is
 *   idempotent: normalizing an already-normalized value is a no-op.
 * - Wraps `swid` in `{}` when the braces are missing, without doubling them if
 *   they're already there.
 *
 * Never throws: a malformed `%` sequence in `espnS2` falls back to the
 * original (trimmed) value rather than failing the whole request.
 */
export function normalizeEspnCredentials(raw: RawEspnCredentials): EspnCredentials {
  let espnS2 = raw.espnS2?.trim() || undefined;
  let swid = raw.swid?.trim() || undefined;

  if (espnS2 && espnS2.includes("%")) {
    try {
      espnS2 = decodeURIComponent(espnS2);
    } catch {
      // Malformed escape sequence (or an already-decoded value with a stray
      // literal "%"). Keep the trimmed original rather than throwing.
    }
  }

  if (swid) {
    const hasOpen = swid.startsWith("{");
    const hasClose = swid.endsWith("}");
    if (!hasOpen || !hasClose) {
      swid = `${hasOpen ? "" : "{"}${swid}${hasClose ? "" : "}"}`;
    }
  }

  return { espnS2, swid, hasCredentials: !!(espnS2 && swid) };
}

/** How this codebase classifies an ESPN HTTP response for retry/UX purposes. */
export type EspnStatusClassification =
  | "ok"
  | "auth"
  | "not_found"
  | "rate_limited"
  | "server"
  | "other";

/** Classify an ESPN HTTP status code. Never throws. */
export function classifyEspnStatus(status: number): EspnStatusClassification {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "other";
}

/**
 * The header block ESPN's fantasy API expects from a browser session,
 * consolidated from the ~6 copies that used to live at each call site. Merges
 * in `extra` (e.g. `X-Fantasy-Filter`, `Content-Type`) and adds a `Cookie`
 * header whenever both credential fields are present - no `isPrivate` gate,
 * since sending cookies on a request for public league data is harmless and
 * this function has no way to know the league's privacy setting anyway.
 */
export function buildEspnHeaders(
  creds: RawEspnCredentials = {},
  extra?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Origin: "https://fantasy.espn.com",
    Referer: "https://fantasy.espn.com/",
    "Sec-Ch-Ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "X-Fantasy-Platform": "kona-PROD-871ba974fde0504c7ee3018049a715c0af70b886",
    "X-Fantasy-Source": "kona",
    ...extra,
  };

  if (creds.espnS2 && creds.swid) {
    headers.Cookie = `espn_s2=${creds.espnS2}; SWID=${creds.swid}`;
  }

  return headers;
}

export interface FetchEspnOptions {
  creds?: RawEspnCredentials;
  headers?: Record<string, string>;
  /** Max retry attempts for a 429/5xx response. Defaults to 3 (up to 4 total requests). */
  retries?: number;
}

export interface FetchEspnResult {
  response: Response;
  classification: EspnStatusClassification;
}

const MAX_BACKOFF_MS = 8_000;

/**
 * `fetch()` an ESPN URL with the standard headers, retrying on 429 and 5xx
 * with exponential backoff (capped at ~8s), honouring `Retry-After` when ESPN
 * sends one. 401/403/404 are never retried - retrying an auth failure just
 * burns the backoff budget for an answer that isn't going to change.
 *
 * Returns the final response (whether or not retries were exhausted) plus its
 * classification, so callers can branch without re-deriving it from `status`.
 */
export async function fetchEspn(url: string, options: FetchEspnOptions = {}): Promise<FetchEspnResult> {
  const { creds = {}, headers: extraHeaders, retries = 3 } = options;
  const headers = buildEspnHeaders(creds, extraHeaders);

  let attempt = 0;
  for (;;) {
    const response = await fetch(url, { headers });
    const classification = classifyEspnStatus(response.status);

    const retryable = classification === "rate_limited" || classification === "server";
    if (!retryable || attempt >= retries) {
      return { response, classification };
    }

    let delayMs = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        delayMs = Math.min(MAX_BACKOFF_MS, seconds * 1000);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt++;
  }
}
