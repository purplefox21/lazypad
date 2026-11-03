// Kurulumun ayar dosyasına yaptıkları. Geçici HOME kullanılır, gerçek ayarlara dokunulmaz.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { ROOT } from "./helpers.js";

const home = mkdtempSync(join(tmpdir(), "lazypad-setup-"));
const settings = join(home, ".claude", "settings.json");
const backup = settings + ".lazypad-backup";
after(() => rmSync(home, { recursive: true, force: true }));

// Süreç içinde HOME değiştirilmez: modül sabitleri ayrı süreçte doğru HOME ile hesaplansın
function run(fn) {
  const code = `const m = await import(${JSON.stringify(join(ROOT, "src", "setup.js"))}); await m.${fn}();`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const read = () => JSON.parse(readFileSync(settings, "utf8"));
const commandsOf = (s, ev) => (s.hooks?.[ev] || []).flatMap((g) => g.hooks.map((h) => h.command));

const EVENTS = ["PostToolUse", "PostToolUseFailure", "Notification", "PermissionRequest", "SessionEnd"];
const WAITS_TOO = ["UserPromptSubmit", "Stop", "StopFailure"]; // bir de tahtayı dinleyen hook: iki kayıt

describe("hook kurulumu", () => {
  beforeEach(() => {
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
  });

  test("ayar dosyası yokken kurulur, tüm olaylar kayıtlı", () => {
    run("installHooks");
    const s = read();
    for (const ev of EVENTS) assert.equal(commandsOf(s, ev).length, 1, ev);
    for (const ev of WAITS_TOO) {
      assert.equal(commandsOf(s, ev).length, 2, ev);
      assert.ok(commandsOf(s, ev)[0].endsWith(" hook"), ev);
      assert.ok(commandsOf(s, ev)[1].endsWith(" wait"), ev);
    }
    assert.equal(commandsOf(s, "SessionStart").length, 0, "ilk mesajdan önce Claude uyanmıyor");
  });

  test("sık olaylar arka planda, tur sınırları eşzamanlı", () => {
    run("installHooks");
    const opt = (ev, i = 0) => read().hooks[ev][i].hooks[0];
    for (const ev of ["PostToolUse", "PostToolUseFailure", "Notification"]) assert.equal(opt(ev).async, true, ev);
    for (const ev of ["UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest"]) assert.equal(opt(ev).async, undefined, ev);
    assert.equal(opt("PermissionRequest").timeout, 600);
    assert.equal(opt("SessionEnd").timeout, undefined, "SessionEnd süresi uzatılmamalı");
    for (const ev of WAITS_TOO) {
      assert.equal(opt(ev, 1).asyncRewake, true, ev);
      assert.equal(opt(ev, 1).sub, undefined, "iç alan ayara yazılmamalı");
    }
    for (const ev of ["PostToolUse", "Notification"]) assert.equal(read().hooks[ev][0].matcher, undefined, ev);
  });

  test("tekrar kurmak hook'ları çoğaltmaz", () => {
    run("installHooks"); run("installHooks"); run("installHooks");
    for (const ev of EVENTS) assert.equal(commandsOf(read(), ev).length, 1, ev);
    for (const ev of WAITS_TOO) assert.equal(commandsOf(read(), ev).length, 2, ev);
  });

  test("kullanıcının ayarlarına dokunmaz", () => {
    const mine = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "afplay ding.wav" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] } };
    writeFileSync(settings, JSON.stringify(mine));
    run("installHooks");
    let s = read();
    assert.equal(s.model, "opus");
    assert.deepEqual(s.hooks.PreToolUse, mine.hooks.PreToolUse);
    assert.ok(commandsOf(s, "Stop").includes("afplay ding.wav"));
    assert.equal(commandsOf(s, "Stop").length, 3);
    run("removeHooks");
    assert.deepEqual(read(), mine, "kaldırınca ilk haline dönmeli");
  });

  test("eski adla (codeeasy) kurulan hook'lar temizlenir", () => {
    const old = { hooks: { Stop: [{ hooks: [{ type: "command", command: '"/usr/bin/node" "/x/codeeasy/src/index.js" hook' }] }] } };
    writeFileSync(settings, JSON.stringify(old));
    run("installHooks");
    assert.equal(commandsOf(read(), "Stop").filter((c) => c.includes("codeeasy")).length, 0);
  });

  test("yedek bir kez alınır, sonraki kurulumlar üstüne yazmaz", () => {
    writeFileSync(settings, JSON.stringify({ model: "ilk" }));
    run("installHooks");
    assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), { model: "ilk" });
    writeFileSync(settings, JSON.stringify({ model: "ikinci" }));
    run("installHooks");
    assert.deepEqual(JSON.parse(readFileSync(backup, "utf8")), { model: "ilk" });
  });

  test("bağlantı (symlink) olan ayar dosyası bağlantı kalır", () => {
    const real = join(home, "dotfiles-settings.json");
    writeFileSync(real, JSON.stringify({ model: "x" }));
    symlinkSync(real, settings);
    run("installHooks");
    assert.ok(lstatSync(settings).isSymbolicLink());
    assert.equal(JSON.parse(readFileSync(real, "utf8")).model, "x");
    assert.ok(JSON.parse(readFileSync(real, "utf8")).hooks.Stop);
    rmSync(real);
  });

  test("bozuk JSON'un üstüne yazmaz", () => {
    writeFileSync(settings, "{bozuk");
    const code = `const m = await import(${JSON.stringify(join(ROOT, "src", "setup.js"))}); m.installHooks();`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(settings, "utf8"), "{bozuk");
  });

  test("Node yolu sürümlü Cellar dizini değil, PATH'teki yol", () => {
    run("installHooks");
    const cmd = commandsOf(read(), "Stop")[0];
    const which = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
    assert.ok(cmd.startsWith(`"${which}"`), cmd);
    assert.ok(!cmd.includes("/Cellar/"), cmd);
  });

  test("geçici dosya kalmaz", () => {
    run("installHooks");
    const left = spawnSync("ls", ["-a", join(home, ".claude")], { encoding: "utf8" }).stdout;
    assert.ok(!/lazypad-\d+/.test(left), left);
    assert.ok(existsSync(settings) && statSync(settings).size > 0);
  });
});
