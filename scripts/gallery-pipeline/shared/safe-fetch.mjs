import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

function normalizeTrustedHosts(trustedHosts) {
  if (!Array.isArray(trustedHosts) && !(trustedHosts instanceof Set)) {
    throw new TypeError("trustedHosts must be an array or Set of exact hostnames");
  }
  const normalized = new Set(
    [...trustedHosts].map((host) => String(host).trim().toLowerCase()).filter(Boolean),
  );
  if (normalized.size === 0) {
    throw new TypeError("trustedHosts must contain at least one hostname");
  }
  return normalized;
}

function isBlockedHostname(hostname) {
  return (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  );
}

function isBlockedIpv4(address) {
  const octets = address.split(".").map(Number);
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function raceWithAbort(promise, signal) {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Safe fetch aborted"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Safe fetch aborted"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function deadlineError() {
  const error = new Error("Safe fetch deadline exceeded");
  error.name = "AbortError";
  error.code = "DEADLINE_EXCEEDED";
  return error;
}

function timeoutError(timeoutMs) {
  return new Error(`Safe fetch timed out after ${timeoutMs}ms`);
}

export function isPrivateOrLinkLocalAddress(address) {
  const normalized = String(address).trim().toLowerCase().split("%")[0];
  const family = isIP(normalized);
  if (family === 4) {
    return isBlockedIpv4(normalized);
  }
  if (family !== 6) {
    throw new TypeError(`DNS lookup returned an invalid IP address: ${address}`);
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

async function validateDestination(url, trustedHosts, lookup, signal) {
  if (url.protocol !== "https:") {
    throw new TypeError("Safe fetch only permits HTTPS URLs");
  }
  if (url.username || url.password) {
    throw new TypeError("Safe fetch rejects URLs containing credentials");
  }

  const hostname = url.hostname.toLowerCase();
  const addressLiteral = hostname.replace(/^\[|\]$/g, "");
  if (isIP(addressLiteral)) {
    throw new TypeError("Safe fetch rejects literal IP addresses");
  }
  if (isBlockedHostname(hostname)) {
    throw new TypeError(`Safe fetch rejects private hostname: ${hostname}`);
  }
  if (!trustedHosts.has(hostname)) {
    throw new TypeError(`Safe fetch rejected untrusted hostname: ${hostname}`);
  }

  const lookupResult = await raceWithAbort(
    lookup(hostname, { all: true, verbatim: true }),
    signal,
  );
  const addresses = Array.isArray(lookupResult) ? lookupResult : [lookupResult];
  if (addresses.length === 0) {
    throw new TypeError(`DNS lookup returned no addresses for ${hostname}`);
  }
  for (const result of addresses) {
    const address = typeof result === "string" ? result : result?.address;
    if (isPrivateOrLinkLocalAddress(address)) {
      throw new TypeError(`Safe fetch rejected private or link-local address for ${hostname}`);
    }
  }
}

async function readBoundedBody(response, maxBytes, signal, throwIfExpired) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new RangeError(`Response exceeded the ${maxBytes} byte limit`);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const chunks = [];
  let byteLength = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      throwIfExpired();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new RangeError(`Response exceeded the ${maxBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    if (!signal.aborted) reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength);
}

export async function safeFetch(
  input,
  {
    trustedHosts,
    fetchImpl = globalThis.fetch,
    lookup = dnsLookup,
    headers = {},
    maxBytes = 2 * 1024 * 1024,
    timeoutMs = 30_000,
    maxRedirects = 5,
    signal,
    deadlineMilliseconds,
    now = Date.now,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new TypeError("maxRedirects must be a non-negative integer");
  }
  if (
    deadlineMilliseconds !== undefined &&
    (!Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds < 0)
  ) {
    throw new TypeError("deadlineMilliseconds must be a non-negative finite number");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const allowedHosts = normalizeTrustedHosts(trustedHosts);
  const requestStartedAt = now();
  const timeoutDeadlineMilliseconds = requestStartedAt + timeoutMs;
  const effectiveDeadlineMilliseconds = Math.min(
    timeoutDeadlineMilliseconds,
    deadlineMilliseconds ?? Number.POSITIVE_INFINITY,
  );
  const expirationError = deadlineMilliseconds !== undefined &&
      deadlineMilliseconds <= timeoutDeadlineMilliseconds
    ? deadlineError()
    : timeoutError(timeoutMs);
  const throwIfExpired = () => {
    if (now() >= effectiveDeadlineMilliseconds) throw expirationError;
  };
  throwIfExpired();

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  let timeout;

  try {
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    timeout = setTimeout(
      () => controller.abort(expirationError),
      effectiveDeadlineMilliseconds - requestStartedAt,
    );

    let currentUrl = new URL(input);
    let redirectCount = 0;

    while (true) {
      throwIfExpired();
      await validateDestination(currentUrl, allowedHosts, lookup, controller.signal);
      throwIfExpired();
      const response = await raceWithAbort(
        fetchImpl(currentUrl, {
          headers,
          redirect: "manual",
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (now() >= effectiveDeadlineMilliseconds) {
        controller.abort(expirationError);
        try {
          const cancellation = response.body?.cancel(expirationError);
          void cancellation?.catch(() => {});
        } catch {}
        throw expirationError;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        void response.body?.cancel().catch(() => {});
        if (!location) {
          throw new TypeError(`Redirect response ${response.status} did not include a Location header`);
        }
        redirectCount += 1;
        if (redirectCount > maxRedirects) {
          throw new RangeError(`Safe fetch exceeded ${maxRedirects} redirects`);
        }
        currentUrl = new URL(location, currentUrl);
        continue;
      }

      const body = await readBoundedBody(
        response,
        maxBytes,
        controller.signal,
        throwIfExpired,
      );
      throwIfExpired();
      return {
        url: currentUrl.toString(),
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        bytes: body.byteLength,
        body,
        text() {
          return body.toString("utf8");
        },
        json() {
          return JSON.parse(body.toString("utf8"));
        },
      };
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}