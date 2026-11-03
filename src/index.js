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
 *   lazypad stop            Merkezi kapat (Claude bir sonraki işte yeniden başlatır)
 *   lazypad hub | hook | wait   (iç kullanım)
 */
import { BASE, ensureHub, launchBoard, probeHub, readConfig, stopHub, writeConfig } from "./shared.js";

const USAGE = `Kullanım: lazypad <komut>

  setup              Claude Code'a bağla, hook'ları ve Mac uygulamasını kur
  uninstall          Hepsini geri al
  app                Mac uygulamasını yeniden derle
  open [browser]     Tahtayı şimdi aç
  mode <m>           Tahta nerede açılsın: auto | app | browser | none
  stop               Merkezi kapat (Claude bir sonraki işte yeniden başlatır)`;

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
  case "wait":
    await import("./wait.js");
    break;
  case "setup":
    await (await import("./setup.js")).setup();
    break;
  case "uninstall":
    await (await import("./setup.js")).uninstall();
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
    if (!await ensureHub()) {
      console.log(await probeHub() === "foreign"
        ? `${BASE} başka bir uygulama tarafından kullanılıyor. LAZYPAD_PORT ile başka bir port seç.`
        : "Merkez başlatılamadı.");
      process.exitCode = 1;
      break;
    }
    const where = launchBoard(arg || readConfig().open);
    console.log(where === "app" ? "Uygulama açılıyor" : `Tarayıcıda açılıyor: ${BASE}`);
    break;
  }
  case "stop":
    console.log(await stopHub() ? "Merkez kapatıldı" : "Merkez zaten kapalı");
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    break;
  default:
    console.log(`Bilinmeyen komut: ${cmd}\n\n${USAGE}`);
    process.exitCode = 1;
}
