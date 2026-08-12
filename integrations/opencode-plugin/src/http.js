export async function postJSON({ fetchImpl, baseUrl, path, payload, headers = {}, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const raw = await response.text();
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { error: raw };
      }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}
