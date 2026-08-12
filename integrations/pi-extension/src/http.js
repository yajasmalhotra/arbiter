async function requestJSON({ fetchImpl, baseUrl, path, method, payload, headers = {}, timeoutMs, signal }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal
    });
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function postJSON(options) {
  return requestJSON({ ...options, method: "POST" });
}

export function getJSON(options) {
  return requestJSON({ ...options, method: "GET" });
}
