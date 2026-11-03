// Merkez: tek bir arka plan süreci. Tüm Claude oturumlarını (MCP + hook'lar)
// toplar, her projeyi bir sekme yapar, tahtaya yayınlar ve tahtadan gelen cevapları Claude'a iletir.
import http from "node:http";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { CONFIG_DIR, ROOT, PORT, HOST, BASE, getToken, launchBoard, readConfig, writeConfig } from "./shared.js";
import {
  CARD_RULES, MODE_CONTEXT, contextFor, describeTool, failureText, lastAssistantText, notificationText,
  parseAnswer, parseBlocks, readTurnItems, summarize, trunc, userText, wantsBoardCard, wasInterrupted,
} from "./logic.js";

const BOARD_HTML = join(ROOT, "board", "index.html");
const MERMAID_JS = join(ROOT, "board", "vendor", "mermaid.min.js");
const HISTORY_FILE = join(CONFIG_DIR, "history.json");
const MAX_EVENTS = 1000;   // sekme başına, bellekte
const SAVED_EVENTS = 300;  // sekme başına, diskte
const MAX_REPLY = 8000;
const IDLE_MS = Number(process.env.LAZYPAD_IDLE_MS || 20 * 60 * 1000);
const GRACE_MS = Number(process.env.LAZYPAD_GRACE_MS || 10_000); // kopan oturumun geri dönmesi için süre
const WATCH_MS = Number(process.env.LAZYPAD_WATCH_MS || 2000);
const SAVE_MS = Number(process.env.LAZYPAD_SAVE_MS || 3000);
const REJOIN_MS = Number(process.env.LAZYPAD_REJOIN_MS || 30_000); // merkez yeni açıldıysa oturumların dönmesi için süre
const NEED_TIMEOUT_MS = 580_000; // hook'un kendi süresi dolmadan kart kapanır
const LATE_MS = 2000; // arka planda gelen hook'lar Stop'tan bu kadar sonra işlenebilir
const TOKEN = getToken();

const tabs = new Map();     // key(proje dizini) -> { key, name, state }
const live = new Map();     // key -> { running, stoppedAt, attention, inbox, lastSession, transcript }
const turns = new Map();    // key -> { activityId, files:Set, cmds, said, startedAt, tables:Set }
const history = new Map();  // key -> olaylar
const boards = new Set();
const sessions = new Set();
const asks = new Map();     // id -> { tab, owner, options, multi, answer, grace }
const needs = new Map();    // id -> { id, kind, tab, sid, tool, input, res, timer }  (izin, seçenekli soru, plan)
const waiters = new Map();  // oturum -> { res, tab }  (tur bitince tahtayı dinleyen hook)
let lastActivity = Date.now();
let lastOpen = 0;
let saveTimer = null;

// ---------------------------------------------------------------- yardımcılar
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

function liveFor(key) {
  let l = live.get(key);
  if (!l) { l = { running: new Map(), stoppedAt: new Map(), attention: false, inbox: [], lastSession: null, transcript: null }; live.set(key, l); }
  return l;
}

const hasOpenNeed = (key) => [...needs.values()].some((n) => n.tab === key);

/** Sekme durumu tek yerden hesaplanır: karar/izin bekliyorsa turuncu, tur sürüyorsa mor. */
function refreshState(tab) {
  if (!tab) return;
  const l = liveFor(tab.key);
  const waiting = l.attention || hasOpenNeed(tab.key) || [...asks.values()].some((a) => a.tab === tab.key && a.answer === null);
  const state = waiting ? "waiting" : l.running.size ? "working" : "idle";
  if (tab.state === state) return;
  tab.state = state;
  sendBoards({ type: "tab", tab });
}

function fileSize(path) {
  try { return statSync(path).size; } catch { return 0; }
}
function fileMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function markRunning(l, sid, path) {
  if (l.running.has(sid)) return;
  // Bu noktadan önce transcript'e yazılanlar eski tura ait
  const from = fileSize(path);
  l.running.set(sid, { path, from, size: from, pos: from, pendingText: null });
}

function markStopped(l, sid) {
  l.running.delete(sid);
  l.stoppedAt.set(sid, Date.now());
  l.attention = false;
}

function turnFor(key) {
  let t = turns.get(key);
  if (!t) { t = newTurn(); turns.set(key, t); }
  return t;
}
const newTurn = () => ({ activityId: randomUUID(), files: new Set(), cmds: 0, said: false, startedAt: Date.now(), tables: new Set(), cardAsked: false, pendingFull: null });
const hasMcpSession = (key) => [...sessions].some((s) => s.tabKey === key);
const tableKey = (columns) => JSON.stringify(columns.map((c) => String(c).trim().toLowerCase()));

function emit(ev) {
  lastActivity = Date.now();
  ev.id ??= randomUUID();
  ev.at ??= Date.now();
  let list = history.get(ev.tab);
  if (!list) { list = []; history.set(ev.tab, list); }
  const i = ev.upsert ? list.findLastIndex((e) => e.id === ev.id) : -1;
  if (i >= 0) list[i] = ev;
  else {
    list.push(ev);
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  }
  sendBoards(ev);
  saveSoon();
  return ev;
}

// ---------------------------------------------------------------- geçmişi sakla
// Görseller çok yer tutar, diske yazılmaz
const forDisk = (ev) => {
  if (ev.kind === "image") return { ...ev, data: { ...ev.data, src: null } };
  if (ev.type === "page") return { ...ev, html: ev.html.replace(/src=(["'])data:.*?\1/g, 'src=""') };
  return ev;
};

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const events = {};
    for (const [key, list] of history) events[key] = list.slice(-SAVED_EVENTS).map(forDisk);
    const tmp = `${HISTORY_FILE}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ tabs: [...tabs.values()].map(({ key, name }) => ({ key, name })), events }), { mode: 0o600 });
    renameSync(tmp, HISTORY_FILE);
  } catch (e) { console.error("lazypad geçmiş:", e.message); }
}
function saveSoon() {
  saveTimer ??= setTimeout(saveNow, SAVE_MS);
  saveTimer.unref?.();
}

function loadSaved() {
  let saved;
  try { saved = JSON.parse(readFileSync(HISTORY_FILE, "utf8")); } catch { return; }
  for (const { key, name } of saved.tabs || []) tabs.set(key, { key, name, state: "idle" });
  for (const [key, list] of Object.entries(saved.events || {})) {
    if (!tabs.has(key)) continue;
    history.set(key, list);
    // Yeniden başlamadan önce açık kalan kartlar: izinlerin hook'u gitti, kararlar oturum dönerse yeniden açılır
    const closed = new Set(list.filter((e) => ["answered", "ask_closed", "need_closed"].includes(e.type)).map((e) => e.askId || e.needId));
    for (const e of [...list]) {
      if (e.type === "prompt" && e.delivery === "queued") e.delivery = "failed"; // sıra bellekteydi, yeniden gönderilebilir
      if (closed.has(e.id)) continue;
      if (e.type === "need") list.push({ type: "need_closed", id: randomUUID(), at: Date.now(), tab: key, needId: e.id, by: "restart" });
      if (e.type === "ask") setTimeout(() => { if (!asks.has(e.id)) emit({ type: "ask_closed", askId: e.id, tab: key, reason: "session" }); }, GRACE_MS * 2).unref();
    }
  }
}

// ---------------------------------------------------------------- tahtayı aç
function openBoard() {
  if (process.env.LAZYPAD_NO_OPEN) return;
  if (boards.size > 0 || Date.now() - lastOpen < 30_000) return;
  lastOpen = Date.now();
  const mode = process.env.LAZYPAD_OPEN || readConfig().open || "auto";
  if (mode !== "none") launchBoard(mode);
}

function notifyMac(title, text) {
  if (process.platform !== "darwin" || process.env.LAZYPAD_NO_NOTIFY) return;
  spawn("osascript", [
    "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e", "end run", title, text,
  ], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// ---------------------------------------------------------------- anlatım modu
// visual: önce görsel, balanced: dengeli, text: yazıyla
let explain = readConfig().explain || "visual";

// ---------------------------------------------------------------- tahtadan gelen yazı
const boardMessage = (texts) => "[Lazypad] The user wrote this on the Lazypad board, not in chat. Treat it as their message. " +
  "Start your chat reply with one line quoting it in their language, so the chat keeps the whole conversation.\n\n" + texts.join("\n\n");

function setDelivery(key, id, delivery) {
  const ev = history.get(key)?.findLast((e) => e.id === id);
  if (ev) emit({ ...ev, delivery, upsert: true });
}

/** Sıradaki yazıları alır ve Claude'a giden tek metne çevirir. */
function takeInbox(l, key) {
  if (!l.inbox.length) return null;
  const items = l.inbox.splice(0);
  for (const it of items) setDelivery(key, it.id, "sent");
  return boardMessage(items.map((it) => it.text));
}

function releaseWaiter(sid, msg = { type: "cancel" }) {
  const w = waiters.get(sid);
  if (!w) return;
  waiters.delete(sid);
  w.res.end(JSON.stringify(msg));
}

/** Claude boştaysa bekleyen hook üzerinden hemen uyandırır. */
function flushToWaiter(tab) {
  const l = liveFor(tab.key);
  const sid = l.lastSession;
  // Claude çalışıyorsa yazı bir sonraki adımda ya da tur sonunda gider; uyandırma yalnızca boştayken
  if (!l.inbox.length || !sid || !waiters.has(sid) || l.running.has(sid)) return;
  const text = takeInbox(l, tab.key);
  releaseWaiter(sid, { type: "reply", text });
  turns.set(tab.key, newTurn());
  l.attention = false;
  markRunning(l, sid, l.transcript);
  refreshState(tab);
}

function sendReply(tab, raw) {
  const text = String(raw ?? "").trim().slice(0, MAX_REPLY);
  if (!text) return;
  const l = liveFor(tab.key);
  // Açık bir soru ya da karar varsa yazı onun cevabıdır
  const openAsk = [...asks.entries()].reverse().find(([, a]) => a.tab === tab.key && a.answer === null);
  if (openAsk) return answerAsk(openAsk[0], { text });
  const openQuestion = [...needs.values()].reverse().find((n) => n.tab === tab.key && n.kind === "question");
  if (openQuestion) return decideNeed({ id: openQuestion.id, answers: Object.fromEntries(openQuestion.input.questions.map((q) => [q.question, text])) });
  const openPlan = [...needs.values()].reverse().find((n) => n.tab === tab.key && n.kind === "plan");
  if (openPlan) return decideNeed({ id: openPlan.id, message: text });

  const ev = emit({ type: "prompt", tab: tab.key, text: trunc(text, 2000), fromBoard: true, delivery: "queued" });
  l.inbox.push({ id: ev.id, text });
  flushToWaiter(tab);
  // Ulaşılacak oturum yoksa hemen vazgeçme: merkez yeni açıldıysa oturumlar birkaç saniyede döner
  if (l.inbox.length) setTimeout(() => {
    const reachable = (l.lastSession && waiters.has(l.lastSession)) || l.running.size || hasMcpSession(tab.key);
    const i = l.inbox.findIndex((it) => it.id === ev.id);
    if (reachable || i < 0) return;
    l.inbox.splice(i, 1);
    setDelivery(tab.key, ev.id, "failed");
  }, REJOIN_MS).unref();
}

// ---------------------------------------------------------------- transcript takibi
function emitNote(key, text) {
  const blocks = parseBlocks(trunc(text, 20000));
  if (blocks.length) emit({ type: "note", tab: key, blocks });
}

/** Claude'un tur içindeki ara mesajları: ardından başka bir şey geldiyse son cevap değildir, karta düşer. */
function scanSession(key, s) {
  if (!s.path) return;
  const { pos, items } = readTurnItems(s.path, s.pos);
  s.pos = pos;
  for (const it of items) {
    // Tahta özeti yazılırken asıl cevap ara mesaj sayılmaz
    if (s.pendingText && s.pendingText.trim() !== turnFor(key).pendingFull?.trim()) emitNote(key, s.pendingText);
    s.pendingText = it.t === "text" ? it.text : null;
  }
}
const scanTab = (key) => { for (const s of live.get(key)?.running.values() ?? []) scanSession(key, s); };

// Esc ile kesilen turda Stop gelmez: çalışan oturumların transcript'ine bak
setInterval(() => {
  for (const [key, l] of live) {
    for (const [sid, s] of l.running) {
      const size = fileSize(s.path);
      if (size === s.size) continue;
      s.size = size;
      scanSession(key, s);
      if (!wasInterrupted(s.path, s.from)) continue;
      if (s.pendingText) emitNote(key, s.pendingText);
      markStopped(l, sid);
      closeNeedsFor(sid);
      emit({ type: "stopped", tab: key });
      turns.set(key, newTurn());
      refreshState(tabs.get(key));
      flushToWaiter(tabs.get(key)); // sırada bekleyen yazı varsa artık uyandırabilir
    }
  }
}, WATCH_MS).unref();

// ---------------------------------------------------------------- hook olayları
const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

function trackActivity(tab, h) {
  const turn = turnFor(tab.key);
  const inp = h.tool_input || {};
  if (FILE_TOOLS.includes(h.tool_name)) {
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
}

function closeToolNeed(sid, h) {
  const n = [...needs.values()].find((x) => x.sid === sid && x.tool === h.tool_name);
  if (!n) return;
  const answers = h.tool_response?.answers;
  const text = answers && typeof answers === "object" ? Object.values(answers).join(", ") : undefined;
  finishNeed(n, "elsewhere", text);
  n.res.end("");
}

async function handleHook(h, { continued = false, forCard = false } = {}) {
  const tab = tabFor(h.project_dir || h.cwd);
  const l = liveFor(tab.key);
  const sid = h.session_id || "?";
  if (!h.agent_id) {
    l.lastSession = sid;
    if (h.transcript_path) l.transcript = h.transcript_path;
  }
  switch (h.hook_event_name) {
    case "UserPromptSubmit": {
      turns.set(tab.key, newTurn());
      l.attention = false;
      l.running.delete(sid);
      closeNeedsFor(sid);
      markRunning(l, sid, h.transcript_path);
      // Tahtadan uyandırma da buradan geçer: o mesajın kartı zaten var, sistem bildirimi kart olmaz
      const said = userText(h.prompt);
      if (said) emit({ type: "prompt", tab: tab.key, text: trunc(said, 2000) });
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      // Alt ajanların araçları ve Stop'tan sonra işlenen geç olaylar ana turun durumunu değiştirmez
      if (!h.agent_id && Date.now() - (l.stoppedAt.get(sid) || 0) > LATE_MS) {
        l.attention = false;
        markRunning(l, sid, h.transcript_path);
      }
      closeToolNeed(sid, h);
      scanTab(tab.key);
      if (h.hook_event_name === "PostToolUse") trackActivity(tab, h);
      break;
    }
    case "Notification": {
      const text = notificationText(h);
      if (!text || hasOpenNeed(tab.key)) return; // izin kartı zaten açık
      l.attention = true;
      emit({ type: "attention", tab: tab.key, text });
      notifyMac(`Lazypad · ${tab.name}`, text);
      break;
    }
    case "Stop": {
      const s = l.running.get(sid);
      if (forCard) { // Claude şimdi tahta özetini yazıyor: tur bitmedi, bitti kartı özetten sonra çıkar
        if (s) scanSession(tab.key, s);
        return;
      }
      markStopped(l, sid);
      closeNeedsFor(sid);
      const turn = turnFor(tab.key);
      let full = h.last_assistant_message || lastAssistantText(h.transcript_path);
      if (!full && !turn.pendingFull) { await new Promise((r) => setTimeout(r, 300)); full = lastAssistantText(h.transcript_path); }
      if (s) { // son cevaptan önceki ara mesajlar kaybolmasın
        scanSession(tab.key, s);
        if (s.pendingText && !turn.pendingFull && !full.includes(s.pendingText.trim())) emitNote(tab.key, s.pendingText);
      }
      // Özet yazıldıysa bitti kartının içeriği asıl cevaptır, özetten sonraki kısa not değil
      if (turn.pendingFull) full = full?.length > 300 && !turn.pendingFull.includes(full) ? `${turn.pendingFull}\n\n${full}` : turn.pendingFull;
      // Tahta cevabın tamamını gösterir; show ile verilen tablo ikinci kez çıkmaz
      const { blocks, question, quick } = parseAnswer(trunc(full, 20000));
      l.attention = !!question && !continued; // Claude soruyla bitirdiyse sıra kullanıcıda
      emit({
        type: "done", tab: tab.key, summary: summarize(full), question, quick,
        blocks: blocks.filter((b) => b.t !== "table" || !turn.tables.has(tableKey(b.columns))),
        said: turn.said, files: turn.files.size,
      });
      turns.set(tab.key, newTurn());
      if (continued) markRunning(l, sid, l.transcript); // tahtadan yazı vardı, Claude devam ediyor
      else flushToWaiter(tab); // tur biterken gelen yazı kaçmasın
      break;
    }
    case "StopFailure": {
      markStopped(l, sid);
      closeNeedsFor(sid);
      emit({ type: "say", tab: tab.key, level: "warn", text: failureText(h.error) });
      turns.set(tab.key, newTurn());
      break;
    }
    case "SessionEnd": {
      markStopped(l, sid);
      releaseWaiter(sid);
      closeNeedsFor(sid);
      for (const it of l.inbox.splice(0)) setDelivery(tab.key, it.id, "failed");
      break;
    }
  }
  refreshState(tab);
}

/** Hook'a dönen cevap: anlatım modu ve varsa tahtadan gelen yazı Claude'a böyle ulaşır. */
function hookResponse(h) {
  const key = h.project_dir || h.cwd || "claude";
  const l = liveFor(key);
  const name = h.hook_event_name;
  if (name === "UserPromptSubmit") {
    const extra = takeInbox(l, key);
    return { hookSpecificOutput: { hookEventName: name, additionalContext: [contextFor(userText(h.prompt), explain), extra].filter(Boolean).join("\n\n") } };
  }
  if (h.agent_id) return null;
  if (name === "PostToolUse") {
    const extra = takeInbox(l, key);
    return extra && { hookSpecificOutput: { hookEventName: name, additionalContext: extra } };
  }
  if (name === "Stop") {
    const extra = takeInbox(l, key);
    if (extra) return { decision: "block", reason: extra };
    // Uzun cevabın sonunda Claude'dan tahta özetini ister; kartı bir kez ister, döngüye girmez
    const turn = turnFor(key);
    const full = h.last_assistant_message || lastAssistantText(h.transcript_path);
    if (h.stop_hook_active || turn.cardAsked || explain === "text" || !hasMcpSession(key) || !wantsBoardCard(full)) return null;
    turn.cardAsked = true;
    turn.pendingFull = full;
    return { decision: "block", reason: CARD_RULES };
  }
  return null;
}

// ---------------------------------------------------------------- izin, seçenekli soru, plan
function finishNeed(n, by, text) {
  needs.delete(n.id);
  clearTimeout(n.timer);
  emit({ type: "need_closed", tab: n.tab, needId: n.id, by, text });
  refreshState(tabs.get(n.tab));
}

function closeNeedsFor(sid) {
  for (const n of [...needs.values()]) {
    if (n.sid !== sid) continue;
    finishNeed(n, "elsewhere");
    n.res.end("");
  }
}

function openNeed(h, res) {
  const tab = tabFor(h.project_dir || h.cwd);
  const kind = h.tool_name === "AskUserQuestion" ? "question" : h.tool_name === "ExitPlanMode" ? "plan" : "permission";
  const input = h.tool_input || {};
  const ev = emit({
    type: "need", tab: tab.key, kind, tool: h.tool_name,
    ...(kind === "permission" ? describeTool(h.tool_name, input) : {}),
    ...(kind === "question" ? { questions: input.questions || [] } : {}),
    ...(kind === "plan" ? { blocks: parseBlocks(trunc(input.plan, 20000)) } : {}),
  });
  // Tahta kapalıysa kart kayıt olarak kalır, karar VS Code'da verilir
  if (boards.size === 0) { emit({ type: "need_closed", tab: tab.key, needId: ev.id, by: "noboard" }); return res.end(""); }
  const n = { id: ev.id, kind, tab: tab.key, sid: h.session_id || "?", tool: h.tool_name, input, res, timer: null };
  needs.set(n.id, n);
  n.timer = setTimeout(() => { finishNeed(n, "timeout"); res.end(""); }, NEED_TIMEOUT_MS);
  res.on("close", () => { if (needs.get(n.id) === n) finishNeed(n, "elsewhere"); });
  refreshState(tab);
  const say = kind === "question" ? input.questions?.[0]?.question : kind === "plan" ? "Plan onayını bekliyor" : `${h.tool_name} için iznini bekliyor`;
  notifyMac(`Lazypad · ${tab.name}`, say || "Seni bekliyor");
}

function decideNeed(m) {
  const n = needs.get(m.id);
  if (!n) return;
  const note = String(m.message ?? "").trim().slice(0, MAX_REPLY);
  let decision, text;
  if (n.kind === "permission") {
    decision = m.allow ? { behavior: "allow" } : { behavior: "deny", message: note ? `The user denied this on the Lazypad board: ${note}` : "The user denied this on the Lazypad board." };
    text = m.allow ? "Tahtadan izin verildi" : note ? `Tahtadan reddedildi: ${note}` : "Tahtadan reddedildi";
  } else if (n.kind === "question") {
    const known = new Set((n.input.questions || []).map((q) => q.question));
    const pairs = Object.entries(m.answers || {}).filter(([q, a]) => known.has(q) && String(a).trim());
    if (!pairs.length) return;
    // Bu araç hook'tan "izin ver" kabul etmiyor; cevap ret iletisiyle ulaşır, VS Code'daki kutu da kapanır
    decision = { behavior: "deny", message: `The user answered this on the Lazypad board, so this is their answer and not a refusal: ${pairs.map(([q, a]) => `"${q}" = "${String(a).slice(0, MAX_REPLY)}"`).join("; ")}. Continue with these answers.` };
    text = `Cevabın: ${pairs.map(([, a]) => a).join(", ")}`;
  } else {
    if (!note) return; // plan onayı yalnızca VS Code'dan verilebiliyor
    decision = { behavior: "deny", message: `The user reviewed this plan on the Lazypad board and wants changes: ${note}. Revise the plan.` };
    text = `Düzeltme istendi: ${note}`;
  }
  finishNeed(n, "board", text);
  n.res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
}

// ---------------------------------------------------------------- erişim denetimi
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]); // DNS rebinding'e karşı
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));     // localhost'taki başka sayfalar giremez

function tokenOk(value) {
  const a = Buffer.from(String(value ?? "")), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
function parseUrl(raw) {
  try { return new URL(raw, BASE); } catch { return null; }
}

// ---------------------------------------------------------------- HTTP
function serveBoard(res, host) {
  const nonce = randomBytes(16).toString("base64");
  const html = readFileSync(BOARD_HTML, "utf8").replace('<script type="module">', `<script type="module" nonce="${nonce}">`);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' 'self'`,
      "style-src 'unsafe-inline'",
      "img-src data:",
      "font-src data:",
      `connect-src 'self' ws://${host}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  });
  res.end(html);
}

/** Gövdeyi JSON olarak okur. */
function readJson(req, done) {
  let body = "";
  req.setEncoding("utf8"); // çok baytlı harfler parça sınırında bozulmasın
  req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on("end", () => {
    let h = null;
    try { h = JSON.parse(body); } catch {}
    done(h);
  });
}

function handleHookRequest(req, res) {
  readJson(req, async (h) => {
    const out = h && hookResponse(h);
    // Önce durum işlenir, sonra cevap döner: Claude devam edip transcript'e yazdığında tur başlangıcı kaçmasın
    const forCard = out?.reason === CARD_RULES;
    const work = h ? handleHook(h, { forCard, continued: h.hook_event_name === "Stop" && !!out && !forCard }) : null;
    if (out) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    } else res.end("");
    try { await work; }
    catch (e) { console.error("lazypad hook:", e.message); }
  });
}

function handleWait(req, res) {
  readJson(req, (h) => {
    if (!h) return res.end("{}");
    const tab = tabFor(h.project_dir || h.cwd);
    const l = liveFor(tab.key);
    const sid = h.session_id || "?";
    releaseWaiter(sid);
    waiters.set(sid, { res, tab: tab.key });
    res.on("close", () => { if (waiters.get(sid)?.res === res) waiters.delete(sid); });
    if (!h.agent_id) { l.lastSession = sid; if (h.transcript_path) l.transcript = h.transcript_path; }
    flushToWaiter(tab);
  });
}

function handlePermission(req, res) {
  readJson(req, (h) => {
    if (!h) return res.end("");
    try { openNeed(h, res); }
    catch (e) { console.error("lazypad izin:", e.message); res.end(""); }
  });
}

const server = http.createServer((req, res) => {
  const url = parseUrl(req.url);
  if (!url || !HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end(); }
  if (req.method === "GET") {
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") return serveBoard(res, req.headers.host);
      if (url.pathname === "/vendor/mermaid.min.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=86400", "x-content-type-options": "nosniff" });
        return res.end(readFileSync(MERMAID_JS));
      }
    } catch (e) {
      console.error("lazypad http:", e.message);
      res.writeHead(500); return res.end();
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ lazypad: true, pid: process.pid, tabs: tabs.size, boards: boards.size, sessions: sessions.size, waiters: waiters.size, needs: needs.size }));
    }
  }
  if (req.method === "POST") {
    if (!tokenOk(req.headers["x-lazypad-token"])) { res.writeHead(401); return res.end(); }
    if (url.pathname === "/hook") return handleHookRequest(req, res);
    if (url.pathname === "/wait") return handleWait(req, res);
    if (url.pathname === "/permission") return handlePermission(req, res);
    if (url.pathname === "/shutdown") {
      // MCP'ler bunu görünce merkezi hemen yeniden başlatmaz
      const bye = JSON.stringify({ type: "shutdown" });
      for (const s of sessions) if (s.readyState === 1) s.send(bye);
      saveNow();
      res.end("ok");
      return setTimeout(() => process.exit(0), 50);
    }
  }
  res.writeHead(404); res.end();
});

// ---------------------------------------------------------------- kararlar
function deliverAnswer(id) {
  const a = asks.get(id);
  if (!a || a.answer === null || a.owner?.readyState !== 1) return;
  a.owner.send(JSON.stringify({ type: "answer", id, ...a.answer }));
  clearTimeout(a.grace);
  asks.delete(id);
}

function registerAsk(ws, tab, m) {
  const known = asks.get(m.id);
  if (known) { // yeniden bağlanan oturum: aynı karar, yeni soket
    known.owner = ws;
    clearTimeout(known.grace);
    return deliverAnswer(m.id);
  }
  asks.set(m.id, { tab: tab.key, owner: ws, options: m.options || [], multi: !!m.multi, answer: null, grace: null });
  turnFor(tab.key).said = true;
  emit({ type: "ask", id: m.id, upsert: true, tab: tab.key, question: m.question, options: m.options || [], multi: !!m.multi });
  refreshState(tab);
  notifyMac(`Lazypad · ${tab.name}`, m.question);
  openBoard();
}

function closeAsk(id, reason) {
  const a = asks.get(id);
  if (!a) return;
  clearTimeout(a.grace);
  asks.delete(id);
  if (a.answer === null) emit({ type: "ask_closed", askId: id, tab: a.tab, reason });
  refreshState(tabs.get(a.tab));
}

/** Tahtadan gelen cevap: tek seçenek, çoklu seçim ya da serbest yazı. */
function answerAsk(id, { choice, choices, text }) {
  const a = asks.get(id);
  if (!a || a.answer !== null) return;
  const typed = String(text ?? "").trim().slice(0, MAX_REPLY);
  if (typed) a.answer = { choice: typed, typed: true };
  else if (Array.isArray(choices) && a.multi && choices.length && choices.every((c) => a.options.includes(c))) a.answer = { choice: choices.join(", "), choices };
  else if (a.options.includes(choice)) a.answer = { choice };
  else return;
  emit({ type: "answered", askId: id, tab: a.tab, ...a.answer });
  deliverAnswer(id); // sahibi şu an bağlı değilse geri döndüğünde iletilir
  refreshState(tabs.get(a.tab));
}

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({
  server,
  maxPayload: 8 * 1024 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!HOSTS.has(req.headers.host) || (origin && !ORIGINS.has(origin))) return false;
    return tokenOk(req.headers["x-lazypad-token"] ?? parseUrl(req.url)?.searchParams.get("t"));
  },
});

const onMessage = (ws, fn) => ws.on("message", (raw) => {
  try { fn(JSON.parse(String(raw))); } catch (e) { console.error("lazypad ws:", e.message); }
});

/** Projede canlı oturum kalmadıysa sekme "çalışıyor"da takılmasın. */
function settleTab(key) {
  const l = live.get(key);
  if (!l || [...sessions].some((s) => s.tabKey === key)) return;
  l.running.clear();
  l.attention = false;
  refreshState(tabs.get(key));
}

function handleSession(ws) {
  sessions.add(ws);
  ws.on("close", () => {
    sessions.delete(ws);
    for (const [id, a] of asks) {
      if (a.owner !== ws) continue;
      a.owner = null;
      a.grace = setTimeout(() => closeAsk(id, "session"), GRACE_MS);
    }
    setTimeout(() => settleTab(ws.tabKey), GRACE_MS);
  });
  onMessage(ws, (m) => {
    if (m.type === "hello") { ws.tabKey = tabFor(m.cwd).key; openBoard(); return; }
    const tab = tabFor(ws.tabKey);
    scanTab(tab.key); // ara mesaj, ardından gelen görselden önce görünsün
    if (m.type === "say") {
      turnFor(tab.key).said = true;
      emit({ type: "say", tab: tab.key, text: m.text, level: m.level });
      if (m.notify) notifyMac(`Lazypad · ${tab.name}`, m.text);
    } else if (m.type === "draw") emit({ type: "draw", tab: tab.key, title: m.title, mermaid: m.mermaid });
    else if (m.type === "show") {
      if (m.kind === "table") turnFor(tab.key).tables.add(tableKey(m.data.columns));
      emit({ type: "show", tab: tab.key, kind: m.kind, title: m.title, data: m.data });
    } else if (m.type === "step") emit({ type: "step", tab: tab.key, label: m.label, status: m.status });
    else if (m.type === "page") emit({ type: "page", tab: tab.key, title: m.title, html: m.html });
    else if (m.type === "plan") emit({ type: "plan", tab: tab.key, title: m.title, steps: m.steps });
    else if (m.type === "progress") {
      emit({ type: "progress", id: `progress:${tab.key}:${m.label}`, upsert: true, tab: tab.key, label: m.label, current: m.current, total: m.total, unit: m.unit });
    } else if (m.type === "ask") registerAsk(ws, tab, m);
    else if (m.type === "ask_cancel") closeAsk(m.id, m.reason);
  });
}

function handleBoard(ws) {
  boards.add(ws);
  ws.on("close", () => boards.delete(ws));
  ws.send(JSON.stringify({ type: "backlog", tabs: [...tabs.values()], events: [...history.values()].flat(), explain, build: fileMtime(BOARD_HTML) }));
  onMessage(ws, (m) => {
    if (m.type === "explain" && MODE_CONTEXT[m.mode]) {
      explain = m.mode;
      writeConfig({ explain });
      sendBoards({ type: "explain", mode: explain });
    } else if (m.type === "answer") {
      answerAsk(m.id, m);
    } else if (m.type === "decide") {
      decideNeed(m);
    } else if (m.type === "reply" && tabs.has(m.tab)) {
      sendReply(tabs.get(m.tab), m.text);
    } else if (m.type === "close_tab" && tabs.get(m.key)?.state === "idle") {
      tabs.delete(m.key); live.delete(m.key); turns.delete(m.key); history.delete(m.key);
      sendBoards({ type: "tab_closed", key: m.key });
      saveSoon();
    }
  });
}

wss.on("connection", (ws, req) => {
  lastActivity = Date.now();
  ws.on("error", () => {}); // bozuk çerçeve merkezi düşürmesin, bağlantı zaten kapanır
  if (req.url.startsWith("/session")) handleSession(ws);
  else handleBoard(ws);
});

// Kimse yokken bir süre sonra kendini kapat
setInterval(() => {
  if (sessions.size === 0 && boards.size === 0 && waiters.size === 0 && Date.now() - lastActivity > IDLE_MS) { saveNow(); process.exit(0); }
}, 30_000).unref();

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { saveNow(); process.exit(0); });

const onListenError = (e) => {
  // Başka bir merkez zaten çalışıyorsa sessizce çık
  if (e.code === "EADDRINUSE") process.exit(0);
  console.error("lazypad hub:", e.message);
  process.exit(1);
};
wss.on("error", onListenError);
server.on("error", onListenError);
server.listen(PORT, HOST, () => {
  loadSaved();
  console.error(`lazypad: merkez hazır → ${BASE}`);
});
