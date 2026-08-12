import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_AGE_MS = 60 * 60 * 1000;
const MAX_MARKERS = 2048;

function markerPath(directory, input) {
  const key = `${input?.session_id ?? ""}:${input?.tool_use_id ?? ""}`;
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(directory, `${digest}.json`);
}

function clean(directory, now) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((left, right) => right.mtime - left.mtime);
  } catch {
    return;
  }
  for (const [index, entry] of entries.entries()) {
    if (now-entry.mtime > MAX_AGE_MS || index >= MAX_MARKERS) {
      try { fs.unlinkSync(entry.file); } catch { /* best effort */ }
    }
  }
}

export function createMarkerStore(directory, now = () => Date.now()) {
  function mark(input) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    clean(directory, now());
    const file = markerPath(directory, input);
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, JSON.stringify({ verified_at: now() }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  }

  function consume(input) {
    const file = markerPath(directory, input);
    try {
      const stat = fs.statSync(file);
      fs.unlinkSync(file);
      return now()-stat.mtimeMs <= MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  return { mark, consume };
}
