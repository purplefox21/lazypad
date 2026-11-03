// Testler kendi portunda ve geçici HOME'da çalışır: gerçek ayarlara dokunmaz.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENTRY = join(ROOT, "src", "index.js");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check, what = "koşul", ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Zaman aşımı: ${what}`);
    await sleep(20);
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Geçici HOME + boş port. Bu ortamda başlatılan her süreç yalnızca burayı görür. */
export async function makeEnv(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "lazypad-test-"));
  const port = await freePort();
  const env = {
    ...process.env, HOME: home, LAZYPAD_PORT: String(port), LAZYPAD_NO_OPEN: "1", LAZYPAD_NO_NOTIFY: "1",
    LAZYPAD_GRACE_MS: "300", LAZYPAD_WATCH_MS: "50", LAZYPAD_REJOIN_MS: "200", ...extra,
  };
  delete env.CLAUDE_PROJECT_DIR;
  const children = new Set();
  return {
    home, port, env, base: `http://127.0.0.1:${port}`,
    token: () => readFileSync(join(home, ".lazypad", "token"), "utf8").trim(),
    track(p) { children.add(p); p.on("exit", () => children.delete(p)); return p; },
    async cleanup() {
      for (const p of children) p.kill("SIGKILL");
      await sleep(20);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export async function startHub(e) {
  const p = e.track(spawn(process.execPath, [ENTRY, "hub"], { env: e.env, stdio: ["ignore", "ignore", "pipe"] }));
  p.err = "";
  p.stderr.on("data", (c) => { p.err += c; });
  p.done = new Promise((r) => p.on("exit", (code, signal) => r({ code, signal })));
  await waitFor(() => health(e), "merkez");
  return p;
}

export async function health(e) {
  try { return await (await fetch(`${e.base}/health`, { signal: AbortSignal.timeout(300) })).json(); }
  catch { return null; }
}

export async function postHook(e, body) {
  const r = await fetch(`${e.base}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lazypad-token": e.token() },
    body: JSON.stringify(body),
  });
  return r.text();
}

/** Ham HTTP isteği: fetch, Host başlığını değiştirmeye izin vermez. */
export function rawRequest(e, lines) {
  return new Promise((resolve, reject) => {
    const s = net.connect(e.port, "127.0.0.1", () => s.write(lines.join("\r\n") + "\r\n\r\n"));
    let b = "";
    s.on("data", (d) => { b += d; });
    s.on("close", () => resolve(b.split("\r\n")[0]));
    s.on("error", reject);
  });
}

/** Tahta ya da oturum istemcisi; gelen mesajları `msgs`te biriktirir. */
export function client(e, path = "/board", { token = e.token(), origin } = {}) {
  return new Promise((resolve, reject) => {
    const c = new WebSocket(`ws://127.0.0.1:${e.port}${path}`, {
      headers: token ? { "x-lazypad-token": token } : {},
      ...(origin ? { origin } : {}),
    });
    c.msgs = [];
    c.on("message", (m) => c.msgs.push(JSON.parse(String(m))));
    c.json = (o) => c.send(JSON.stringify(o));
    c.seen = (pred, what) => waitFor(() => c.msgs.find(pred), what);
    c.once("open", () => resolve(c));
    c.once("error", reject);
  });
}

export const tabState = (board, key) => {
  let state;
  for (const m of board.msgs) {
    if (m.type === "backlog") state = m.tabs.find((t) => t.key === key)?.state ?? state;
    if (m.type === "tab" && m.tab.key === key) state = m.tab.state;
  }
  return state;
};
