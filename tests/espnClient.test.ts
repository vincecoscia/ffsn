import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEspnHeaders,
  classifyEspnStatus,
  fetchEspn,
  normalizeEspnCredentials,
} from "../convex/lib/espnClient";

describe("normalizeEspnCredentials", () => {
  it("trims whitespace from both fields", () => {
    const result = normalizeEspnCredentials({ espnS2: "  abc123  ", swid: "  {ABC}  " });
    expect(result.espnS2).toBe("abc123");
    expect(result.swid).toBe("{ABC}");
  });

  it("decodes a URL-encoded espn_s2 exactly once", () => {
    const raw = encodeURIComponent("AEB123/xyz+==");
    const result = normalizeEspnCredentials({ espnS2: raw, swid: "{ABC}" });
    expect(result.espnS2).toBe("AEB123/xyz+==");
  });

  it("is idempotent on an already-decoded espn_s2 (no stray % to trip a second decode)", () => {
    const once = normalizeEspnCredentials({ espnS2: encodeURIComponent("AEB123/xyz+=="), swid: "ABC" });
    const twice = normalizeEspnCredentials({ espnS2: once.espnS2, swid: once.swid });
    expect(twice.espnS2).toBe(once.espnS2);
    expect(twice.swid).toBe(once.swid);
  });

  it("wraps a bare SWID in braces", () => {
    const result = normalizeEspnCredentials({ espnS2: "abc", swid: "1234-5678-ABCD" });
    expect(result.swid).toBe("{1234-5678-ABCD}");
  });

  it("does not double-wrap a SWID that already has braces", () => {
    const result = normalizeEspnCredentials({ espnS2: "abc", swid: "{1234-5678-ABCD}" });
    expect(result.swid).toBe("{1234-5678-ABCD}");
  });

  it("is idempotent when applied twice to a brace-wrapped SWID", () => {
    const once = normalizeEspnCredentials({ espnS2: "abc", swid: "1234" });
    const twice = normalizeEspnCredentials({ espnS2: once.espnS2, swid: once.swid });
    expect(twice.swid).toBe(once.swid);
    expect(twice.swid).toBe("{1234}");
  });

  it("falls back to the trimmed original when espn_s2 has a malformed escape", () => {
    const result = normalizeEspnCredentials({ espnS2: "abc%zz", swid: "{ABC}" });
    expect(result.espnS2).toBe("abc%zz");
  });

  it("reports hasCredentials only when both fields are present", () => {
    expect(normalizeEspnCredentials({}).hasCredentials).toBe(false);
    expect(normalizeEspnCredentials({ espnS2: "abc" }).hasCredentials).toBe(false);
    expect(normalizeEspnCredentials({ swid: "{ABC}" }).hasCredentials).toBe(false);
    expect(normalizeEspnCredentials({ espnS2: "abc", swid: "{ABC}" }).hasCredentials).toBe(true);
  });

  it("treats blank strings as absent", () => {
    const result = normalizeEspnCredentials({ espnS2: "   ", swid: "   " });
    expect(result.espnS2).toBeUndefined();
    expect(result.swid).toBeUndefined();
    expect(result.hasCredentials).toBe(false);
  });
});

describe("classifyEspnStatus", () => {
  it.each([
    [200, "ok"],
    [204, "ok"],
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [302, "other"],
    [418, "other"],
  ] as const)("classifies %i as %s", (status, expected) => {
    expect(classifyEspnStatus(status)).toBe(expected);
  });
});

describe("buildEspnHeaders", () => {
  it("includes the standard header block without credentials", () => {
    const headers = buildEspnHeaders();
    expect(headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(headers["X-Fantasy-Source"]).toBe("kona");
    expect(headers.Cookie).toBeUndefined();
  });

  it("adds a Cookie header only when both credential fields are present", () => {
    expect(buildEspnHeaders({ espnS2: "abc" }).Cookie).toBeUndefined();
    expect(buildEspnHeaders({ swid: "{ABC}" }).Cookie).toBeUndefined();
    const headers = buildEspnHeaders({ espnS2: "abc", swid: "{ABC}" });
    expect(headers.Cookie).toBe("espn_s2=abc; SWID={ABC}");
  });

  it("merges in extra headers, letting them override the standard block", () => {
    const headers = buildEspnHeaders(undefined, { "X-Fantasy-Filter": "{}", Accept: "text/plain" });
    expect(headers["X-Fantasy-Filter"]).toBe("{}");
    expect(headers.Accept).toBe("text/plain");
  });
});

describe("fetchEspn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify({}), { status, headers });
  }

  it("returns immediately on a 200 without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const { response, classification } = await fetchEspn("https://example.com/league");

    expect(classification).toBe("ok");
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries a 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401));
    vi.stubGlobal("fetch", fetchMock);

    const { classification } = await fetchEspn("https://example.com/league");

    expect(classification).toBe("auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries a 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(404));
    vi.stubGlobal("fetch", fetchMock);

    const { classification } = await fetchEspn("https://example.com/league");

    expect(classification).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 with backoff, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("setTimeout", ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const { response, classification } = await fetchEspn("https://example.com/league", { retries: 3 });

    expect(classification).toBe("ok");
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After on a 429", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const delays: number[] = [];
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await fetchEspn("https://example.com/league");

    expect(delays[0]).toBe(1000);
  });

  it("gives up after exhausting retries on repeated 5xx and returns the last response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("setTimeout", ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const { classification } = await fetchEspn("https://example.com/league", { retries: 2 });

    expect(classification).toBe("server");
    // Initial attempt + 2 retries = 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends the built headers, including Cookie when credentials are present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    await fetchEspn("https://example.com/league", { creds: { espnS2: "abc", swid: "{ABC}" } });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Cookie).toBe("espn_s2=abc; SWID={ABC}");
  });
});
