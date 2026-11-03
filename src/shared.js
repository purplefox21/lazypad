// Ortak ayarlar ve yardımcılar
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
export const APP_PATHS = ["/Applications/Lazypad.app", join(homedir(), "Applications", "Lazypad.app")];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
export function writeConfig(patch) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...readConfig(), ...patch };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

export async function hubAlive() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
    return (await r.json()).lazypad === true;
  } catch { return false; }
}

/** Merkez çalışmıyorsa arka planda başlatır. */
export async function ensureHub() {
  if (await hubAlive()) return true;
  spawn(process.execPath, [ENTRY, "hub"], { detached: true, stdio: "ignore", env: process.env }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (await hubAlive()) return true;
  }
  return false;
}

export function findApp() {
  return process.platform === "darwin" ? APP_PATHS.find((p) => existsSync(p)) : undefined;
}
