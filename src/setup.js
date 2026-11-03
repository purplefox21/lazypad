// Kurulum / kaldırma / Mac uygulaması derleme
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmSync, renameSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR, ENTRY, ROOT, APP_PATHS, stopHub } from "./shared.js";

const SETTINGS = join(homedir(), ".claude", "settings.json");
// Sık gelen olaylar arka planda çalışır, Claude'u hiç bekletmez. SessionEnd varsayılan süresinde kalır,
// yoksa çıkış gecikebilir. Tur sınırları sıralı işlensin diye UserPromptSubmit ve Stop eşzamanlıdır.
// PermissionRequest tahtadan cevap bekler (VS Code'daki kutu da açıktır). "wait" tahtayı dinler: her mesajda ve
// tur bitince yenilenir. SessionStart'ta değil: ilk mesajdan önce Claude uyanmıyor, yazı sırada beklemeli.
const WAIT = { sub: "wait", asyncRewake: true, timeout: 86_400 };
const HOOK_EVENTS = {
  UserPromptSubmit: [{ timeout: 5 }, WAIT],
  PostToolUse: [{ async: true }],
  PostToolUseFailure: [{ async: true }],
  Notification: [{ async: true }],
  PermissionRequest: [{ timeout: 600 }],
  Stop: [{ timeout: 5 }, WAIT],
  StopFailure: [{ timeout: 5 }, WAIT],
  SessionEnd: [{}],
};
// Bizim hook'umuz: bu kurulum ya da eski adla (codeeasy) yapılmış kurulumlar
const isOurs = (h) => typeof h?.command === "string" && / (hook|wait)$/.test(h.command) &&
  (h.command.includes(ENTRY) || /(codeeasy|lazypad)[^"]*src[\\/]index\.js"? (hook|wait)$/i.test(h.command));

const say = (s) => console.log(s);
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8", shell: process.platform === "win32" });

/** PATH'teki node: Homebrew'in sürümlü yolu (Cellar/…) güncellemeden sonra yok olur, hook'lar kırılır. */
function nodePath() {
  const found = run(process.platform === "win32" ? "where" : "which", ["node"]).stdout?.split(/\r?\n/)[0]?.trim();
  try { if (found && realpathSync(found) === realpathSync(process.execPath)) return found; } catch {}
  return process.execPath;
}
const NODE = nodePath();

// ---------------------------------------------------------------- MCP kaydı
function registerMcp() {
  run("claude", ["mcp", "remove", "--scope", "user", "codeeasy"]); // eski ad
  run("claude", ["mcp", "remove", "--scope", "user", "lazypad"]);
  const r = run("claude", ["mcp", "add", "--scope", "user", "lazypad", "--", NODE, ENTRY]);
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
  mkdirSync(dirname(SETTINGS), { recursive: true });
  // Yedek bir kez alınır: sonraki kurulumlar ilk halinin üstüne yazmasın
  const backup = SETTINGS + ".lazypad-backup";
  if (existsSync(SETTINGS) && !existsSync(backup)) copyFileSync(SETTINGS, backup);
  // Yarıda kesilirse ayarlar bozulmasın; dosya bağlantıysa (dotfiles) bağlantı korunsun
  const target = existsSync(SETTINGS) ? realpathSync(SETTINGS) : SETTINGS;
  const tmp = `${target}.lazypad-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, target);
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
export function installHooks() {
  const s = loadSettings();
  stripOurs(s);
  s.hooks ??= {};
  for (const [ev, entries] of Object.entries(HOOK_EVENTS)) {
    s.hooks[ev] ??= [];
    for (const { sub = "hook", ...opts } of entries) {
      s.hooks[ev].push({ hooks: [{ type: "command", command: `"${NODE}" "${ENTRY}" ${sub}`, ...opts }] });
    }
  }
  saveSettings(s);
  say("  ✓ Otomatik takip (hook'lar) kuruldu → " + SETTINGS);
}
export function removeHooks() {
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
  try {
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
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    try { renameSync(app, dest); }
    catch (e) {
      if (e.code !== "EXDEV") throw e; // geçici dizin başka diskteyse
      cpSync(app, dest, { recursive: true, verbatimSymlinks: true });
    }
    say("  ✓ Lazypad.app kuruldu → " + dest);
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- komutlar
export async function setup() {
  say("\nLazypad kuruluyor\n");
  const okMcp = registerMcp();
  try { installHooks(); } catch (e) { say("  ✗ " + e.message); }
  buildApp();
  await stopHub(); // eski sürüm çalışıyorsa yenisi bir sonraki oturumla başlasın
  say(okMcp
    ? "\nHazır. Claude Code'u yeniden başlat, tahta kendiliğinden açılacak.\n"
    : "\nMCP elle eklenmeli:\n  claude mcp add --scope user lazypad -- \"" + NODE + "\" \"" + ENTRY + "\"\n");
}

export async function uninstall() {
  say("\nLazypad kaldırılıyor\n");
  unregisterMcp();
  try { removeHooks(); } catch (e) { say("  ✗ " + e.message); }
  for (const p of APP_PATHS) if (existsSync(p) && p.startsWith(homedir())) { rmSync(p, { recursive: true, force: true }); say("  ✓ Uygulama silindi"); }
  await stopHub();
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  say("  ✓ Ayarlar ve erişim anahtarı silindi (" + CONFIG_DIR + ")");
  say("\nAçık Claude Code oturumlarını yeniden başlat.\n");
}
