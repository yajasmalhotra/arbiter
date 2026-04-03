function joinUrl(baseUrl, path) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  return new URL(normalized, base).toString();
}

async function parseJSONResponse(resp) {
  const text = await resp.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export async function postJSON({ fetchImpl, baseUrl, path, headers, payload, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(joinUrl(baseUrl, path), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const body = await parseJSONResponse(response);
    return {
      status: response.status,
      ok: response.ok,
      body
    };
  } finally {
    clearTimeout(timeout);
  }
}
