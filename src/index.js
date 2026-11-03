#!/usr/bin/env node
/**
 * Lazypad — Claude Code için sesli + görsel tahta.
 *
 *   lazypad                 MCP sunucusu (Claude Code bunu kendisi başlatır)
 *   lazypad setup           Claude Code'a bağla + hook'lar + Mac uygulaması
 *   lazypad uninstall       Hepsini geri al
 *   lazypad app             Sadece Mac uygulamasını (yeniden) derle
 *   lazypad open            Tahtayı şimdi aç
 *   lazypad mode <m>        Tahta nerede açılsın: auto | app | browser | none
 *   lazypad stop            Merkezi kapat
 *   lazypad hub | hook      (iç kullanım)
 */
import { spawn } from "node:child_process";
import { BASE, ensureHub, writeConfig, findApp, readConfig } from "./shared.js";

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case undefined:
    await import("./mcp.js");
    break;
  case "hub":
    await import("./hub.js");
    break;
  case "hook":
    await import("./hook.js");
    break;
  case "setup":
    (await import("./setup.js")).setup();
    break;
  case "uninstall":
    (await import("./setup.js")).uninstall();
    break;
  case "app":
    (await import("./setup.js")).buildApp();
    break;
  case "mode": {
    if (!["auto", "app", "browser", "none"].includes(arg)) {
      console.log(`Şu an: ${readConfig().open || "auto"}\nKullanım: lazypad mode auto|app|browser|none`);
      break;
    }
    writeConfig({ open: arg });
    console.log(`Tahta artık şurada açılacak: ${arg}`);
    break;
  }
  case "open": {
    await ensureHub();
    const app = findApp();
    const useApp = app && (arg || readConfig().open) !== "browser";
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, useApp ? ["-a", app] : [BASE], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    console.log(useApp ? "Uygulama açılıyor" : `Tarayıcıda açılıyor: ${BASE}`);
    break;
  }
  case "stop":
    try {
      await fetch(`${BASE}/shutdown`, { method: "POST", headers: { "x-lazypad": "1" } });
      console.log("Merkez kapatıldı");
    } catch { console.log("Merkez zaten kapalı"); }
    break;
  default:
    console.log("Bilinmeyen komut. Kullanım için: src/index.js dosyasının başına bak");
}
