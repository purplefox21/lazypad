// Merkez: tek bir arka plan süreci. Tüm Claude oturumlarını (MCP + hook'lar)
// toplar, her projeyi bir sekme yapar ve tahtaya (uygulama/tarayıcı) yayınlar.
import http from "node:http";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, join, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { ROOT, PORT, HOST, BASE, readConfig, writeConfig, findApp } from "./shared.js";

const BOARD_HTML = join(ROOT, "board", "index.html");
const MAX_EVENTS = 3000;
const IDLE_MS = Number(process.env.LAZYPAD_IDLE_MS || 20 * 60 * 1000);

const tabs = new Map();     // key(cwd) -> { key, name, state }
const turns = new Map();    // key -> { activityId, files:Set, cmds, said, startedAt }
const history = [];
const boards = new Set();
const sessions = new Set();
const askOwners = new Map(); // askId -> session ws
let lastActivity = Date.now();
let lastOpen = 0;

// ---------------------------------------------------------------- yardımcılar
const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function sendBoards(msg) {
  const data = JSON.stringify(msg);
  for (const ws of boards) if (ws.readyState === 1) ws.send(data);
}

function tabFor(cwd) {
  const key = cwd || "claude";
  let t = tabs.get(key);
  if (!t) {
    t = { key, name: basename(key) || "Claude", state: "idle" };
    tabs.set(key, t);
    sendBoards({ type: "tab", tab: t });
  }
  return t;
}

function setState(tab, state) {
  if (tab.state === state) return;
  tab.state = state;
  sendBoards({ type: "tab", tab });
}

function turnFor(key) {
  let t = turns.get(key);
  if (!t) { t = newTurn(); turns.set(key, t); }
  return t;
}
const newTurn = () => ({ activityId: randomUUID(), files: new Set(), cmds: 0, said: false, startedAt: Date.now() });

function emit(ev) {
  lastActivity = Date.now();
  ev.id ??= randomUUID();
  ev.at ??= Date.now();
  if (ev.upsert) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].id === ev.id) { history[i] = ev; sendBoards(ev); return; }
    }
  }
  history.push(ev);
  if (history.length > MAX_EVENTS) history.splice(0, history.length - MAX_EVENTS);
  sendBoards(ev);
}

// ---------------------------------------------------------------- tahtayı aç
function openBoard() {
  if (process.env.LAZYPAD_NO_OPEN) return;
  if (boards.size > 0 || Date.now() - lastOpen < 30_000) return;
  lastOpen = Date.now();
  const mode = process.env.LAZYPAD_OPEN || readConfig().open || "auto";
  if (mode === "none") return;
  const app = findApp();
  try {
    if (app && mode !== "browser") {
      spawn("open", ["-a", app], { stdio: "ignore", detached: true }).unref();
    } else {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(cmd, [BASE], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    }
  } catch { /* açılamazsa adres zaten belli */ }
}

function notifyMac(title, text) {
  if (process.platform !== "darwin" || process.env.LAZYPAD_NO_NOTIFY) return;
  try {
    spawn("osascript", [
      "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e", "end run", title, text,
    ], { stdio: "ignore", detached: true }).unref();
  } catch {}
}

// ---------------------------------------------------------------- anlatım modu
// visual: önce görsel, balanced: dengeli, text: yazıyla
let explain = readConfig().explain || "visual";
const VISUAL_GUIDE =
  "Pick the form by the content: flow, architecture, call order, cause->effect -> `draw` (Mermaid flowchart / sequenceDiagram / mindmap / stateDiagram); " +
  "options, comparisons, before/after -> `show` kind=table or kind=compare; numbers, sizes, trends, timings -> `show` kind=chart; " +
  "key takeaways or a summary of many points -> `show` kind=points. One visual per idea, small and labeled in the user's language.";
const MODE_CONTEXT = {
  visual:
    "[Lazypad] Explanation mode: VISUAL. The user is tired of reading; explain on the Lazypad board instead of in text. " +
    VISUAL_GUIDE + " In the chat reply write at most 3 short lines (outcome first); no long paragraphs, no markdown tables or bullet walls in chat.",
  balanced:
    "[Lazypad] Explanation mode: BALANCED. Put anything with structure (flows, comparisons, numbers) on the Lazypad board. " +
    VISUAL_GUIDE + " Keep the chat reply concise (about 8 lines max).",
  text:
    "[Lazypad] Explanation mode: TEXT. The user wants a written explanation; write it clearly in chat. Board visuals are optional.",
};
const WANTS_TEXT = /(yazıyla|metinle|metin olarak|yazarak|detaylı (yaz|anlat)|uzun uzun|açıklama yaz|in text|write it out)/i;
const WANTS_VISUAL = /(çiz|şema|görsel(le)?|diyagram|grafik|tabloyla|tablo (yap|olarak)|draw|diagram|chart|visuali[sz]e)/i;

function contextFor(prompt = "") {
  let mode = explain;
  let note = "";
  if (WANTS_TEXT.test(prompt)) { mode = "text"; note = " (The user explicitly asked for text this time.)"; }
  else if (WANTS_VISUAL.test(prompt)) { mode = "visual"; note = " (The user explicitly asked for a visual this time.)"; }
  return MODE_CONTEXT[mode] + note;
}

// ---------------------------------------------------------------- hook olayları
function trNotification(msg = "") {
  const perm = msg.match(/permission to use (.+)$/i);
  if (perm) return `${perm[1]} için iznini bekliyor`;
  if (/waiting for your input|idle/i.test(msg)) return "Senden cevap bekliyor";
  return msg || "Seni bekliyor";
}

/** Uzun metinden konuşulabilir kısa özet çıkarır. */
export function summarize(full) {
  const clean = (p) => p
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^#+.*$/gm, " ")
    .replace(/[*_`>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  // İlk anlamlı paragraf (başlıklar, kod blokları ve listeler hariç)
  const paras = String(full || "").replace(/```[\s\S]*?```/g, "\n\n").split(/\n\s*\n/).map(clean);
  const s = paras.find((p) => p.length >= 20) || paras.find(Boolean) || "";
  if (!s) return "Bitti.";
  // Cümle sonu: noktadan sonra boşluk ya da metin sonu (dosya adlarındaki noktalar bölünmez)
  const sentences = s.match(/[\s\S]*?[.!?](?=\s|$)|[\s\S]+$/g) || [s];
  let out = "";
  for (const sen of sentences) {
    if (out && (out + sen).length > 220) break;
    out += sen;
  }
  return trunc(out.trim(), 240);
}

/** Transcript dosyasından son asistan metnini okur (sadece bu tur). */
export function lastAssistantText(path) {
  if (!path || !existsSync(path)) return "";
  try {
    const size = statSync(path).size;
    const len = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "user" && typeof o.message?.content === "string") return ""; // tur başı
      if (o.type === "assistant" && Array.isArray(o.message?.content)) {
        const text = o.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
        if (text) return text;
      }
    }
  } catch {}
  return "";
}

async function handleHook(h) {
  const tab = tabFor(h.cwd);
  const turn = turnFor(tab.key);
  switch (h.hook_event_name) {
    case "UserPromptSubmit": {
      turns.set(tab.key, newTurn());
      emit({ type: "prompt", tab: tab.key, text: trunc(h.prompt, 500) });
      setState(tab, "working");
      break;
    }
    case "PostToolUse": {
      const inp = h.tool_input || {};
      if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(h.tool_name)) {
        const f = inp.file_path || inp.notebook_path;
        if (!f) return;
        const rel = isAbsolute(f) ? relative(tab.key, f) : f;
        turn.files.add(rel.startsWith("..") ? f : rel);
      } else if (h.tool_name === "Bash") {
        turn.cmds++;
      } else return;
      emit({
        type: "activity", id: turn.activityId, upsert: true, tab: tab.key,
        files: [...turn.files], cmds: turn.cmds, at: turn.startedAt,
      });
      setState(tab, "working");
      break;
    }
    case "Notification": {
      const text = trNotification(h.message);
      emit({ type: "attention", tab: tab.key, text });
      setState(tab, "waiting");
      notifyMac(`Lazypad · ${tab.name}`, text);
      break;
    }
    case "Stop": {
      let full = h.last_assistant_message || lastAssistantText(h.transcript_path);
      if (!full) { await new Promise((r) => setTimeout(r, 300)); full = lastAssistantText(h.transcript_path); }
      emit({
        type: "done", tab: tab.key, summary: summarize(full), full: trunc(full, 20000),
        said: turn.said, files: turn.files.size,
      });
      setState(tab, "idle");
      turns.set(tab.key, newTurn());
      break;
    }
  }
}

// ---------------------------------------------------------------- HTTP
const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(BOARD_HTML));
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ lazypad: true, pid: process.pid, tabs: tabs.size, events: history.length }));
  }
  // Yazma uçları özel başlık ister: tarayıcıdaki yabancı siteler bunu gönderemez.
  if (req.method === "POST" && req.headers["x-lazypad"] === "1") {
    if (url.pathname === "/shutdown") { res.end("ok"); return setTimeout(() => process.exit(0), 50); }
    if (url.pathname === "/hook") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on("end", async () => {
        let h = null;
        try { h = JSON.parse(body); } catch {}
        if (h?.hook_event_name === "UserPromptSubmit") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: contextFor(h.prompt) },
          }));
        } else res.end("");
        try { if (h) await handleHook(h); } catch {}
      });
      return;
    }
  }
  res.writeHead(404); res.end();
});

// ---------------------------------------------------------------- WebSocket
const allowedOrigin = (o) => !o || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);
const wss = new WebSocketServer({ server, verifyClient: ({ origin }) => allowedOrigin(origin) });

wss.on("connection", (ws, req) => {
  lastActivity = Date.now();
  const isSession = req.url.startsWith("/session");
  if (isSession) {
    sessions.add(ws);
    ws.on("close", () => sessions.delete(ws));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "hello") { ws.tab = tabFor(m.cwd); openBoard(); return; }
      const tab = ws.tab || tabFor(null);
      const turn = turnFor(tab.key);
      if (m.type === "say") { turn.said = true; emit({ type: "say", tab: tab.key, text: m.text, level: m.level }); }
      else if (m.type === "draw") emit({ type: "draw", tab: tab.key, title: m.title, mermaid: m.mermaid });
      else if (m.type === "show") emit({ type: "show", tab: tab.key, kind: m.kind, title: m.title, data: m.data });
      else if (m.type === "step") {
        emit({ type: "step", tab: tab.key, label: m.label, status: m.status });
        if (m.status === "doing") setState(tab, "working");
      } else if (m.type === "ask") {
        askOwners.set(m.id, ws);
        turn.said = true;
        emit({ type: "ask", id: m.id, tab: tab.key, question: m.question, options: m.options });
        setState(tab, "waiting");
        notifyMac(`Lazypad · ${tab.name}`, m.question);
      }
    });
    return;
  }

  boards.add(ws);
  ws.on("close", () => boards.delete(ws));
  ws.send(JSON.stringify({ type: "backlog", tabs: [...tabs.values()], events: history, explain }));
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === "explain" && MODE_CONTEXT[m.mode]) {
      explain = m.mode;
      writeConfig({ explain });
      sendBoards({ type: "explain", mode: explain });
      return;
    }
    if (m.type === "answer" && askOwners.has(m.id)) {
      const owner = askOwners.get(m.id);
      askOwners.delete(m.id);
      if (owner.readyState === 1) owner.send(JSON.stringify({ type: "answer", id: m.id, choice: m.choice }));
      const ask = history.find((e) => e.id === m.id);
      emit({ type: "answered", askId: m.id, tab: ask?.tab, choice: m.choice });
      if (ask) setState(tabFor(ask.tab), "working");
    }
  });
});

// Kimse yokken bir süre sonra kendini kapat
setInterval(() => {
  if (sessions.size === 0 && boards.size === 0 && Date.now() - lastActivity > IDLE_MS) process.exit(0);
}, 30_000).unref();

server.on("error", (e) => {
  // Başka bir merkez zaten çalışıyorsa sessizce çık
  if (e.code === "EADDRINUSE") process.exit(0);
  console.error("lazypad hub:", e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.error(`lazypad: merkez hazır → ${BASE}`));
