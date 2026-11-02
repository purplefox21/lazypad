#!/usr/bin/env node
/**
 * CodeEasy — Claude Code için sesli + görsel tahta.
 *
 * Bir MCP sunucusudur (stdio). Claude Code'a 4 araç verir:
 *   say(text, level)        → tahta seslendirir + zaman çizgisine ekler
 *   draw(title, mermaid)    → tahtaya şema çizer
 *   step(label, status)     → ilerleme listesi günceller
 *   ask(question, options)  → tahtada karar kartı açar, cevabı bekler
 *
 * Ayrıca http://localhost:4242 adresinde Tahta'yı (board) sunar.
 * Ses, tarayıcının Web Speech API'siyle çalınır — macOS'ta bu
 * Apple'ın kendi sesleridir (Türkçe: Yelda).
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOARD_HTML = join(__dirname, "..", "board", "index.html");
const BASE_PORT = Number(process.env.CODEEASY_PORT || 4242);

// ---------------------------------------------------------------------------
// Tahta (web) sunucusu
// ---------------------------------------------------------------------------
const history = []; // tahta yeni açıldığında geçmişi gönderebilmek için
const pendingAsks = new Map(); // id -> resolve

const httpServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(BOARD_HTML));
  } else if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, events: history.length }));
  } else {
    res.writeHead(404);
    res.end("yok");
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  // Yeni açılan tahtaya geçmişi gönder (ses tekrar çalınmaz, replay: true)
  ws.send(JSON.stringify({ type: "backlog", events: history }));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "answer" && pendingAsks.has(msg.id)) {
      pendingAsks.get(msg.id)(msg.choice);
      pendingAsks.delete(msg.id);
      broadcast({ type: "answered", id: msg.id, choice: msg.choice, at: Date.now() });
    }
  });
});

function broadcast(event) {
  history.push(event);
  const data = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function listen(port, attemptsLeft = 10) {
  httpServer.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error("codeeasy: tahta sunucusu açılamadı:", err.message);
    }
  });
  httpServer.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.error(`codeeasy: tahta hazır → ${url}`);
    tryOpenBrowser(url);
  });
}

function tryOpenBrowser(url) {
  if (process.env.CODEEASY_NO_OPEN) return;
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch { /* tarayıcı açılamazsa sorun değil, URL loglandı */ }
}

// ---------------------------------------------------------------------------
// `codeeasy setup` → Claude Code'a tek komutla bağla
// ---------------------------------------------------------------------------
if (process.argv[2] === "setup") {
  const self = fileURLToPath(import.meta.url);
  const args = ["mcp", "add", "--scope", "user", "codeeasy", "--", process.execPath, self];
  console.log("codeeasy: Claude Code'a ekleniyor…");
  const r = spawn("claude", args, { stdio: "inherit", shell: process.platform === "win32" });
  r.on("exit", (code) => {
    if (code === 0) {
      console.log("\n✓ Hazır. Claude Code'u (yeniden) başlat — tahta kendiliğinden açılacak.");
    } else {
      console.log("\nOtomatik ekleme olmadı. Elle şunu çalıştır:\n  claude " +
        args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
    }
    process.exit(code ?? 1);
  });
  r.on("error", () => {
    console.log("`claude` komutu bulunamadı. Önce Claude Code'u kur: https://claude.com/claude-code");
    process.exit(1);
  });
} else {
  listen(BASE_PORT);
}

// ---------------------------------------------------------------------------
// MCP sunucusu — Claude'un kullanacağı araçlar
// ---------------------------------------------------------------------------
const INSTRUCTIONS = `CodeEasy is the user's voice + visual board. The user does NOT want to read long text.
Rules while working:
- Call \`step\` for each meaningful step (status doing when starting, done/fail when finished).
- Tell important things with \`say\`: max 2 short sentences, the user's language. Use level "warn" only for things the user must know.
- Explain flows, architecture and cause→effect with \`draw\` (small Mermaid diagram) instead of long text.
- Ask with \`ask\` ONLY for decisions that are hard to reverse or truly the user's call; decide routine things yourself. Put the recommended option first.
- Never use emojis in say/draw/step/ask content.
- In the chat itself keep replies to 3-5 short lines; the board carries the rest.`;

const mcp = new McpServer({ name: "codeeasy", version: "0.2.0" }, { instructions: INSTRUCTIONS });

mcp.tool(
  "say",
  "Speak a SHORT message (max 2 sentences) aloud to the user on the CodeEasy board. " +
    "Use level 'ok' for done/info, 'warn' for something the user must know, " +
    "'question' only together with the ask tool. Speak the user's language.",
  {
    text: z.string().max(400).describe("Short spoken message, max 2 sentences"),
    level: z.enum(["ok", "warn"]).default("ok").describe("ok = info/done, warn = important"),
  },
  async ({ text, level }) => {
    broadcast({ type: "say", id: randomUUID(), text, level, at: Date.now() });
    return { content: [{ type: "text", text: "söylendi" }] };
  }
);

mcp.tool(
  "draw",
  "Draw a diagram on the CodeEasy board using Mermaid syntax. Use this INSTEAD of long text " +
    "explanations: flows, architecture, cause→effect. Keep diagrams small (3-10 nodes), " +
    "label nodes in the user's language.",
  {
    title: z.string().max(80).describe("Short title shown above the diagram"),
    mermaid: z.string().max(4000).describe("Mermaid diagram source, e.g. 'graph LR; A-->B'"),
  },
  async ({ title, mermaid }) => {
    broadcast({ type: "draw", id: randomUUID(), title, mermaid, at: Date.now() });
    return { content: [{ type: "text", text: "çizildi" }] };
  }
);

mcp.tool(
  "step",
  "Update the progress checklist on the CodeEasy board. Call when starting (doing) and " +
    "finishing (done/fail) each meaningful step of the task.",
  {
    label: z.string().max(120).describe("Step name, short, user's language"),
    status: z.enum(["doing", "done", "fail"]).describe("Step state"),
  },
  async ({ label, status }) => {
    broadcast({ type: "step", id: randomUUID(), label, status, at: Date.now() });
    return { content: [{ type: "text", text: "güncellendi" }] };
  }
);

mcp.tool(
  "ask",
  "Ask the user to make a decision via a card on the CodeEasy board (also spoken aloud). " +
    "Use ONLY for decisions that are hard to reverse or genuinely the user's call — " +
    "decide routine things yourself. Blocks until the user answers. Returns the chosen option.",
  {
    question: z.string().max(300).describe("The decision question, short, user's language"),
    options: z.array(z.string().max(80)).min(2).max(4).describe("2-4 short options; put the recommended one first"),
  },
  async ({ question, options }) => {
    const id = randomUUID();
    const answer = await new Promise((resolve) => {
      pendingAsks.set(id, resolve);
      broadcast({ type: "ask", id, question, options, at: Date.now() });
      // 10 dakika cevap gelmezse Claude'u sonsuza kadar bekletme
      setTimeout(() => {
        if (pendingAsks.has(id)) {
          pendingAsks.delete(id);
          resolve(null);
        }
      }, 10 * 60 * 1000).unref();
    });
    return {
      content: [{
        type: "text",
        text: answer === null
          ? "Kullanıcı cevap vermedi (zaman aşımı). Güvenli/önerilen seçenekle devam et ve bunu söyle."
          : `Kullanıcının seçimi: ${answer}`,
      }],
    };
  }
);

if (!process.env.CODEEASY_TEST && process.argv[2] !== "setup") {
  await mcp.connect(new StdioServerTransport());
  console.error("codeeasy: MCP bağlı (say, draw, step, ask hazır)");
}
