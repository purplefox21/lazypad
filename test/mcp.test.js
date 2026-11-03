// Gerçek MCP süreci + gerçek merkez, Claude Code'un yerine sahte istemci.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { ENTRY, client, health, makeEnv, postHook, sleep, startHub, tabState, waitFor } from "./helpers.js";

function startMcp(e, extraEnv = {}) {
  const p = e.track(spawn(process.execPath, [ENTRY], { env: { ...e.env, CLAUDE_PROJECT_DIR: "/m/proj", ...extraEnv }, stdio: ["pipe", "pipe", "ignore"] }));
  const waiting = new Map();
  let buf = "", nextId = 1;
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  p.done = new Promise((r) => p.on("exit", (code, signal) => r({ code, signal })));
  const write = (o) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  p.request = (method, params) => {
    const id = nextId++;
    const reply = new Promise((resolve) => waiting.set(id, resolve));
    write({ id, method, params });
    return Object.assign(reply, { rpcId: id });
  };
  p.notify = (method, params) => write({ method, params });
  p.call = (name, args) => p.request("tools/call", { name, arguments: args });
  p.init = async () => {
    p.initResult = (await p.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })).result;
    p.notify("notifications/initialized");
  };
  return p;
}

const text = (r) => r.result.content[0].text;

describe("MCP aracı → tahta", () => {
  let e, board, mcp;
  before(async () => {
    e = await makeEnv();
    await startHub(e);
    board = await client(e, "/board");
    mcp = startMcp(e);
    await mcp.init();
    await board.seen((m) => m.type === "tab" && m.tab.key === "/m/proj", "sekme");
  });
  after(async () => { board.close(); await e.cleanup(); });

  test("beş araç da listelenir, talimatlar gelir", async () => {
    const r = await mcp.request("tools/list");
    assert.deepEqual(r.result.tools.map((t) => t.name).sort(), ["ask", "draw", "page", "plan", "progress", "say", "show", "step"]);
    const show = r.result.tools.find((t) => t.name === "show");
    assert.ok(show.inputSchema.properties.content, "show şeması content içermeli");
  });
  test("talimatlar tam cevabı sohbette tutar, tahta yerine geçmez", async () => {
    const { instructions } = mcp.initResult;
    assert.match(instructions, /complete answer in chat/);
    assert.doesNotMatch(instructions, /does NOT want to read|Keep the final chat reply short|instead of/i);
    const { tools } = (await mcp.request("tools/list")).result;
    for (const name of ["draw", "show"]) assert.doesNotMatch(tools.find((t) => t.name === name).description, /instead of/i, name);
  });
  test("say / draw / step tahtaya gider", async () => {
    await mcp.call("say", { text: "Merhaba" });
    await board.seen((m) => m.type === "say" && m.text === "Merhaba" && m.level === "ok" && m.tab === "/m/proj", "say");
    await mcp.call("draw", { title: "Akış", mermaid: "graph LR; A-->B" });
    await board.seen((m) => m.type === "draw" && m.title === "Akış", "draw");
    await mcp.call("step", { label: "Adım", status: "doing" });
    await board.seen((m) => m.type === "step" && m.label === "Adım", "step");
  });
  test("show türleri doğrulanır", async () => {
    const chart = { kind: "chart", chart: "line", labels: ["a", "b"], series: [{ name: "s", values: [-1, 2] }], unit: "%" };
    assert.equal(text(await mcp.call("show", { title: "G", content: chart })), "gösterildi");
    const ev = await board.seen((m) => m.type === "show" && m.kind === "chart", "show");
    assert.deepEqual(ev.data.series[0].values, [-1, 2]);
    for (const content of [
      { kind: "table", columns: ["a"], rows: [["1"], [2]] },
      { kind: "compare", left: { label: "L", items: ["x"] }, right: { label: "R", items: ["y"] } },
      { kind: "points", items: [{ title: "T" }] },
    ]) assert.equal(text(await mcp.call("show", { title: "T", content })), "gösterildi");
  });
  test("yeni kart türleri: kod, fark, dosyalar", async () => {
    await mcp.call("show", { title: "Kod", content: { kind: "code", code: "const a = 1;", language: "js", path: "src/a.js" } });
    assert.equal((await board.seen((m) => m.type === "show" && m.kind === "code", "kod")).data.path, "src/a.js");
    await mcp.call("show", { title: "Fark", content: { kind: "diff", diff: "-eski\n+yeni" } });
    await board.seen((m) => m.type === "show" && m.kind === "diff", "fark");
    await mcp.call("show", { title: "Dosyalar", content: { kind: "files", items: [{ path: "src/a.js", line: 3, note: "Burada" }] } });
    assert.equal((await board.seen((m) => m.type === "show" && m.kind === "files", "dosyalar")).data.items[0].line, 3);
  });
  test("görsel gömülür; eksik ya da desteklenmeyen dosya hata verir", async () => {
    const png = join(e.home, "a.png");
    writeFileSync(png, Buffer.from("iVBORw0KGgo=", "base64"));
    assert.equal(text(await mcp.call("show", { title: "Ekran", content: { kind: "image", path: png, caption: "Giriş" } })), "gösterildi");
    const ev = await board.seen((m) => m.type === "show" && m.kind === "image", "görsel");
    assert.match(ev.data.src, /^data:image\/png;base64,/);
    assert.equal((await mcp.call("show", { title: "Yok", content: { kind: "image", path: join(e.home, "yok.png") } })).result.isError, true);
    const txt = join(e.home, "a.txt");
    writeFileSync(txt, "gizli");
    assert.equal((await mcp.call("show", { title: "Metin", content: { kind: "image", path: txt } })).result.isError, true);
  });
  test("serbest sayfa: dosya yolundaki görseller gömülür, hazır gömülüler bozulmaz", async () => {
    const png = join(e.home, "foto.png");
    writeFileSync(png, Buffer.from("iVBORw0KGgo=", "base64"));
    const html = `<div class="cols"><img src="${png}" alt="a"><img alt="b" src='file://${png}'><img src="data:image/gif;base64,R0lG"></div>`;
    assert.equal(text(await mcp.call("page", { title: "Önce ve sonra", html })), "gösterildi");
    const ev = await board.seen((m) => m.type === "page", "sayfa");
    assert.equal(ev.title, "Önce ve sonra");
    assert.equal((ev.html.match(/data:image\/png;base64,/g) || []).length, 2);
    assert.match(ev.html, /data:image\/gif/);
    assert.ok(!ev.html.includes(png), "dosya yolu sayfada kalmamalı");
  });
  test("serbest sayfa: görsel olmayan dosya ve eksik dosya reddedilir", async () => {
    const secret = join(e.home, "gizli.txt");
    writeFileSync(secret, "gizli");
    assert.equal((await mcp.call("page", { title: "T", html: `<img src="${secret}">` })).result.isError, true);
    assert.equal((await mcp.call("page", { title: "T", html: `<img src="${join(e.home, "yok.png")}">` })).result.isError, true);
    assert.equal((await mcp.call("page", { title: "T", html: `<img src="https://x.y/z.png">` })).result.isError, true);
  });
  test("plan ve ilerleme", async () => {
    await mcp.call("plan", { title: "İş planı", steps: ["Oku", "Yaz"] });
    assert.deepEqual((await board.seen((m) => m.type === "plan", "plan")).steps, ["Oku", "Yaz"]);
    await mcp.call("progress", { label: "Testler", current: 1, total: 4, unit: "test" });
    const first = await board.seen((m) => m.type === "progress" && m.current === 1, "ilerleme");
    await mcp.call("progress", { label: "Testler", current: 4, total: 4, unit: "test" });
    const last = await board.seen((m) => m.type === "progress" && m.current === 4, "ilerleme son");
    assert.equal(first.id, last.id, "aynı çubuk güncellenmeli");
    assert.equal(last.upsert, true);
  });
  test("eksik seri değeri hata olarak döner", async () => {
    const bad = { kind: "chart", chart: "bar", labels: ["a", "b"], series: [{ name: "s", values: [1] }] };
    const r = await mcp.call("show", { title: "G", content: bad });
    assert.equal(r.result.isError, true);
  });
  test("şemaya uymayan girdi reddedilir", async () => {
    const r = await mcp.call("show", { title: "G", content: { kind: "yok" } });
    assert.ok(r.error || r.result.isError);
  });
});

describe("ask", () => {
  let e;
  beforeEach(async () => { e = await makeEnv(); });
  afterEach(() => e.cleanup());

  test("cevap Claude'a döner", async () => {
    await startHub(e);
    const board = await client(e, "/board");
    const mcp = startMcp(e);
    await mcp.init();
    const pending = mcp.call("ask", { question: "Silinsin mi?", options: ["Hayır", "Evet"] });
    const card = await board.seen((m) => m.type === "ask", "kart");
    board.json({ type: "answer", id: card.id, choice: "Evet" });
    assert.equal(text(await pending), "Kullanıcının seçimi: Evet");
    board.close();
  });

  test("kullanıcı kendi cevabını yazabilir; seçeneksiz soru da olur", async () => {
    await startHub(e);
    const board = await client(e, "/board");
    const mcp = startMcp(e);
    await mcp.init();
    const pending = mcp.call("ask", { question: "Adı ne olsun?" });
    const card = await board.seen((m) => m.type === "ask", "kart");
    assert.deepEqual(card.options, []);
    board.json({ type: "answer", id: card.id, text: "lazypad-2" });
    assert.equal(text(await pending), "Kullanıcı kendi cevabını yazdı: lazypad-2");
    board.close();
  });

  test("çoklu seçim; seçeneklerde olmayan yok sayılır", async () => {
    await startHub(e);
    const board = await client(e, "/board");
    const mcp = startMcp(e);
    await mcp.init();
    const pending = mcp.call("ask", { question: "Hangileri?", options: ["A", "B", "C"], multi: true });
    const card = await board.seen((m) => m.type === "ask", "kart");
    assert.equal(card.multi, true);
    board.json({ type: "answer", id: card.id, choices: ["A", "Z"] });
    await sleep(50);
    board.json({ type: "answer", id: card.id, choices: ["A", "C"] });
    assert.equal(text(await pending), "Kullanıcının seçimi: A, C");
    const ev = await board.seen((m) => m.type === "answered", "cevap");
    assert.deepEqual(ev.choices, ["A", "C"]);
    board.close();
  });

  test("tahtadaki yazı kutusu açık kararı cevaplar", async () => {
    await startHub(e);
    const board = await client(e, "/board");
    const mcp = startMcp(e);
    await mcp.init();
    const pending = mcp.call("ask", { question: "Devam?", options: ["Evet", "Hayır"] });
    const card = await board.seen((m) => m.type === "ask", "kart");
    board.json({ type: "reply", tab: card.tab, text: "önce testleri çalıştır" });
    assert.equal(text(await pending), "Kullanıcı kendi cevabını yazdı: önce testleri çalıştır");
    board.close();
  });

  test("zaman aşımı onay sayılmaz, kart kapanır", async () => {
    await startHub(e);
    const board = await client(e, "/board");
    const mcp = startMcp(e, { LAZYPAD_ASK_TIMEOUT_MS: "200" });
    await mcp.init();
    const r = await mcp.call("ask", { question: "Silinsin mi?", options: ["Hayır", "Evet"] });
    assert.match(text(r), /onay sayma/);
    assert.doesNotMatch(text(r), /önerilen seçenekle devam/i);
    const ev = await board.seen((m) => m.type === "ask_closed", "kapanma");
    assert.equal(ev.reason, "timeout");
    await waitFor(() => tabState(board, "/m/proj") === "idle", "boşta");
    board.close();
  });

  test("Claude isteği iptal edince kart kapanır", async () => {
    await startHub(e);
    const board = await client(e, "/board");
    const mcp = startMcp(e);
    await mcp.init();
    const pending = mcp.call("ask", { question: "Silinsin mi?", options: ["Hayır", "Evet"] });
    await board.seen((m) => m.type === "ask", "kart");
    mcp.notify("notifications/cancelled", { requestId: pending.rpcId, reason: "esc" });
    const ev = await board.seen((m) => m.type === "ask_closed", "kapanma");
    assert.equal(ev.reason, "cancelled");
    board.close();
  });

  test("merkez kapanıp açılınca bekleyen karar yeniden kart olur ve cevap ulaşır", async () => {
    const hub = await startHub(e);
    const board1 = await client(e, "/board");
    const mcp = startMcp(e);
    await mcp.init();
    const pending = mcp.call("ask", { question: "Silinsin mi?", options: ["Hayır", "Evet"] });
    const first = await board1.seen((m) => m.type === "ask", "ilk kart");
    board1.close();
    hub.kill("SIGKILL"); // beklenmedik düşüş
    await hub.done;
    await waitFor(() => health(e), "merkez yeniden ayakta", 8000);
    const board2 = await client(e, "/board");
    const card = await waitFor(async () => {
      const backlog = board2.msgs.find((m) => m.type === "backlog");
      return backlog?.events.find((ev) => ev.type === "ask") ?? board2.msgs.find((m) => m.type === "ask");
    }, "yeniden kart", 8000);
    assert.equal(card.id, first.id);
    board2.json({ type: "answer", id: card.id, choice: "Hayır" });
    assert.equal(text(await pending), "Kullanıcının seçimi: Hayır");
    board2.close();
    const { pid } = await health(e);
    process.kill(pid, "SIGKILL");
  });
});

describe("süreç ömrü", () => {
  let e;
  beforeEach(async () => { e = await makeEnv(); });
  afterEach(() => e.cleanup());

  test("stdin kapanınca MCP çıkar", async () => {
    await startHub(e);
    const mcp = startMcp(e);
    await mcp.init();
    await waitFor(async () => (await health(e)).sessions === 1, "oturum");
    mcp.stdin.end();
    const end = await Promise.race([mcp.done, sleep(3000).then(() => "çıkmadı")]);
    assert.deepEqual(end, { code: 0, signal: null });
    await waitFor(async () => (await health(e)).sessions === 0, "oturum kapandı");
  });

  test("stop merkezi kapatır, canlı MCP hemen geri getirmez, sonraki iş getirir", async () => {
    const hub = await startHub(e);
    const mcp = startMcp(e);
    await mcp.init();
    await waitFor(async () => (await health(e)).sessions === 1, "oturum");
    const stop = spawnSync(process.execPath, [ENTRY, "stop"], { env: e.env, encoding: "utf8" });
    assert.match(stop.stdout, /kapatıldı/);
    await hub.done;
    await sleep(2500); // eski kod bu sürede yeniden başlatıyordu
    assert.equal(await health(e), null, "merkez kapalı kalmalı");
    await mcp.call("say", { text: "geri döndüm" });
    await waitFor(() => health(e), "merkez geri geldi", 5000);
    const board = await client(e, "/board");
    await board.seen(
      (m) => (m.type === "say" && m.text === "geri döndüm") || (m.type === "backlog" && m.events.some((ev) => ev.text === "geri döndüm")),
      "mesaj kaybolmadı",
    );
    board.close();
    const { pid } = await health(e);
    process.kill(pid, "SIGKILL");
  });

  test("stop sonrası başkası merkezi açarsa MCP kendiliğinden geri bağlanır", async () => {
    const hub = await startHub(e);
    const mcp = startMcp(e);
    await mcp.init();
    await waitFor(async () => (await health(e))?.sessions === 1, "oturum");
    spawnSync(process.execPath, [ENTRY, "stop"], { env: e.env });
    await hub.done;
    await startHub(e);
    await waitFor(async () => (await health(e))?.sessions === 1, "geri bağlandı", 9000);
  });

  test("hook süreci: kapalı merkezi başlatır ve anlatım modunu döndürür", async () => {
    const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/m/proj/sub", prompt: "akışı çiz" });
    const r = spawnSync(process.execPath, [ENTRY, "hook"], { env: { ...e.env, CLAUDE_PROJECT_DIR: "/m/proj" }, input, encoding: "utf8" });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(out.hookSpecificOutput.additionalContext, /VISUAL/);
    assert.match(out.hookSpecificOutput.additionalContext, /complete answer in chat/);
    const board = await client(e, "/board");
    const backlog = await board.seen((m) => m.type === "backlog", "backlog");
    assert.ok(backlog.tabs.some((t) => t.key === "/m/proj"), "sekme proje kökünde olmalı");
    assert.ok(!backlog.tabs.some((t) => t.key === "/m/proj/sub"));
    board.close();
    const { pid } = await health(e);
    process.kill(pid, "SIGKILL");
  });

  test("hook, merkez kapalıyken ve bozuk girdide sessizce çıkar", async () => {
    for (const input of ["{bozuk", JSON.stringify({ hook_event_name: "Stop", session_id: "s" })]) {
      const r = spawnSync(process.execPath, [ENTRY, "hook"], { env: e.env, input, encoding: "utf8" });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    }
    assert.equal(await health(e), null, "Stop merkezi başlatmamalı");
  });

  test("port başka uygulamadaysa open anlaşılır hata verir", async () => {
    const http = await import("node:http");
    const other = http.createServer((_, res) => res.end("başka uygulama"));
    await new Promise((r) => other.listen(e.port, "127.0.0.1", r));
    try {
      // spawnSync bu süreci kilitler, sahte sunucu cevap veremezdi
      const p = spawn(process.execPath, [ENTRY, "open"], { env: e.env, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (c) => { out += c; });
      const code = await new Promise((r) => p.on("exit", r));
      assert.equal(code, 1);
      assert.match(out, /başka bir uygulama/);
    } finally {
      other.closeAllConnections();
      await new Promise((res) => other.close(res));
    }
  });

  test("hook ile tur uçtan uca", async () => {
    await startHub(e);
    const board = await client(e, "/board");
    await postHook(e, { hook_event_name: "UserPromptSubmit", session_id: "s", project_dir: "/m/x", prompt: "selam" });
    await postHook(e, { hook_event_name: "Stop", session_id: "s", project_dir: "/m/x", last_assistant_message: "Token yenileme düzeltildi.\n\nAyrıntılar burada." });
    const done = await board.seen((m) => m.type === "done", "bitti");
    assert.equal(done.summary, "Token yenileme düzeltildi.");
    assert.equal(done.blocks[1].text, "Ayrıntılar burada.");
    board.close();
  });
});
