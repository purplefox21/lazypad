// Ortak ayarlar ve yardımcılar
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "index.js");
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env.LAZYPAD_PORT || 4242);
export const HOST = "127.0.0.1";
export const BASE = `http://${HOST}:${PORT}`;
export const CONFIG_DIR = join(homedir(), ".lazypad");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const TOKEN_FILE = join(CONFIG_DIR, "token");
export const APP_PATHS = ["/Applications/Lazypad.app", join(homedir(), "Applications", "Lazypad.app")];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
export function writeConfig(patch) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const next = { ...readConfig(), ...patch };
  const tmp = `${CONFIG_FILE}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, CONFIG_FILE);
  return next;
}

/** Merkeze bağlanmak için gereken anahtar. Yalnızca bu kullanıcının okuyabildiği dosyada durur. */
export function getToken() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) { chmodSync(TOKEN_FILE, 0o600); return t; }
    rmSync(TOKEN_FILE, { force: true });
  } catch {}
  const tmp = `${TOKEN_FILE}.${process.pid}`;
  writeFileSync(tmp, randomBytes(32).toString("hex"), { mode: 0o600 });
  try { linkSync(tmp, TOKEN_FILE); } catch {} // aynı anda başka süreç yazdıysa onunki kalır
  rmSync(tmp, { force: true });
  return readFileSync(TOKEN_FILE, "utf8").trim();
}
export const authHeaders = () => ({ "x-lazypad-token": getToken() });

/** Merkeze JSON gönderir. fetch değil: uzun bekleyen isteklerde fetch beş dakikada kendini keser. */
export function postHub(path, body, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...authHeaders() },
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, out }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

/** Claude kapanınca ya da çökünce hook süreçleri ortada kalmasın. */
export function exitWithParent() {
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 3000).unref();
}

/** "ok": merkez çalışıyor · "down": port boş · "foreign": portu başka bir uygulama kullanıyor */
export async function probeHub() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
    return (await r.json()).lazypad === true ? "ok" : "foreign";
  } catch (e) {
    return e.name === "SyntaxError" ? "foreign" : "down";
  }
}

/** Merkez çalışmıyorsa arka planda başlatır. */
export async function ensureHub() {
  const state = await probeHub();
  if (state !== "down") return state === "ok";
  spawn(process.execPath, [ENTRY, "hub"], { detached: true, stdio: "ignore", env: process.env, cwd: homedir() }).unref();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(100);
    if (await probeHub() === "ok") return true;
  }
  return false;
}

export async function stopHub() {
  try {
    const r = await fetch(`${BASE}/shutdown`, { method: "POST", headers: authHeaders(), signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

export function findApp() {
  return process.platform === "darwin" ? APP_PATHS.find((p) => existsSync(p)) : undefined;
}

/** Tahtayı açar: Mac uygulaması varsa onda, yoksa tarayıcıda. */
export function launchBoard(mode) {
  const app = mode !== "browser" ? findApp() : undefined;
  const win = process.platform === "win32";
  const opener = process.platform === "darwin" ? "open" : win ? "start" : "xdg-open";
  // Anahtar adresin # kısmında: sunucuya gitmez, tahta okuyup adresten siler
  const args = app ? ["-a", app] : [`${BASE}/#t=${getToken()}`];
  spawn(opener, args, { stdio: "ignore", detached: true, shell: win })
    .on("error", () => {}) // açılamazsa merkez düşmesin
    .unref();
  return app ? "app" : "browser";
}
