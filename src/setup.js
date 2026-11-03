// Kurulum / kaldırma / Mac uygulaması derleme
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ENTRY, ROOT, APP_PATHS } from "./shared.js";

const SETTINGS = join(homedir(), ".claude", "settings.json");
const HOOK_CMD = `"${process.execPath}" "${ENTRY}" hook`;
const HOOK_EVENTS = {
  UserPromptSubmit: null,
  PostToolUse: "Edit|Write|MultiEdit|NotebookEdit|Bash",
  Notification: null,
  Stop: null,
};
// Bizim hook'umuz: bu kurulum ya da eski adla (codeeasy) yapılmış kurulumlar
const isOurs = (h) => typeof h?.command === "string" && h.command.endsWith(" hook") &&
  (h.command.includes(ENTRY) || /(codeeasy|lazypad)[^"]*src[\\/]index\.js"? hook$/i.test(h.command));

const say = (s) => console.log(s);
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8", shell: process.platform === "win32" });

// ---------------------------------------------------------------- MCP kaydı
function registerMcp() {
  run("claude", ["mcp", "remove", "--scope", "user", "codeeasy"]); // eski ad
  run("claude", ["mcp", "remove", "--scope", "user", "lazypad"]);
  const r = run("claude", ["mcp", "add", "--scope", "user", "lazypad", "--", process.execPath, ENTRY]);
  if (r.error) { say("  ✗ `claude` komutu bulunamadı. Claude Code kurulu mu?"); return false; }
  if (r.status !== 0) { say("  ✗ MCP eklenemedi:\n" + (r.stderr || r.stdout)); return false; }
  say("  ✓ Claude Code'a MCP olarak eklendi");
  return true;
}
function unregisterMcp() {
  const r = run("claude", ["mcp", "remove", "--scope", "user", "lazypad"]);
  say(r.status === 0 ? "  ✓ MCP kaldırıldı" : "  · MCP zaten kayıtlı değildi");
}

// ---------------------------------------------------------------- hook kaydı
function loadSettings() {
  if (!existsSync(SETTINGS)) return {};
  const raw = readFileSync(SETTINGS, "utf8");
  try { return raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new Error(`${SETTINGS} okunamadı (geçersiz JSON). Elle düzeltip tekrar dene.`); }
}
function saveSettings(s) {
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, SETTINGS + ".lazypad-backup");
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
}
function stripOurs(s) {
  for (const ev of Object.keys(s.hooks || {})) {
    s.hooks[ev] = s.hooks[ev]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
}
function installHooks() {
  const s = loadSettings();
  stripOurs(s);
  s.hooks ??= {};
  for (const [ev, matcher] of Object.entries(HOOK_EVENTS)) {
    s.hooks[ev] ??= [];
    s.hooks[ev].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: HOOK_CMD, timeout: 5 }] });
  }
  saveSettings(s);
  say("  ✓ Otomatik takip (hook'lar) kuruldu → " + SETTINGS);
}
function removeHooks() {
  if (!existsSync(SETTINGS)) return say("  · Hook yoktu");
  const s = loadSettings();
  stripOurs(s);
  saveSettings(s);
  say("  ✓ Hook'lar kaldırıldı");
}

// ---------------------------------------------------------------- Mac uygulaması
export function buildApp() {
  if (process.platform !== "darwin") { say("  · Mac uygulaması sadece macOS'ta derlenir (tarayıcı modu kullanılacak)"); return false; }
  const swiftc = run("xcrun", ["--find", "swiftc"]);
  if (swiftc.status !== 0) {
    say("  · Swift bulunamadı, tarayıcı modu kullanılacak. Uygulama için: xcode-select --install, sonra npm run app");
    return false;
  }
  const work = join(tmpdir(), "lazypad-app-" + process.pid);
  const app = join(work, "Lazypad.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  copyFileSync(join(ROOT, "mac", "Info.plist"), join(app, "Contents", "Info.plist"));
  say("  … Mac uygulaması derleniyor (bir dakika sürebilir)");
  const b = run("xcrun", [
    "swiftc", "-O", join(ROOT, "mac", "Lazypad.swift"),
    "-o", join(app, "Contents", "MacOS", "Lazypad"),
    "-framework", "Cocoa", "-framework", "WebKit", "-framework", "AVFoundation",
  ]);
  if (b.status !== 0) { say("  ✗ Derleme olmadı:\n" + b.stderr); return false; }
  run("codesign", ["--force", "--deep", "-s", "-", app]);
  const dest = APP_PATHS[1]; // ~/Applications
  mkdirSync(join(homedir(), "Applications"), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(app, dest);
  rmSync(work, { recursive: true, force: true });
  say("  ✓ Lazypad.app kuruldu → " + dest);
  return true;
}

// ---------------------------------------------------------------- komutlar
export function setup() {
  say("\nLazypad kuruluyor\n");
  const okMcp = registerMcp();
  try { installHooks(); } catch (e) { say("  ✗ " + e.message); }
  buildApp();
  say(okMcp
    ? "\nHazır. Claude Code'u yeniden başlat, tahta kendiliğinden açılacak.\n"
    : "\nMCP elle eklenmeli:\n  claude mcp add --scope user lazypad -- \"" + process.execPath + "\" \"" + ENTRY + "\"\n");
}

export function uninstall() {
  say("\nLazypad kaldırılıyor\n");
  unregisterMcp();
  try { removeHooks(); } catch (e) { say("  ✗ " + e.message); }
  for (const p of APP_PATHS) if (existsSync(p) && p.startsWith(homedir())) { rmSync(p, { recursive: true, force: true }); say("  ✓ Uygulama silindi"); }
  say("");
}
