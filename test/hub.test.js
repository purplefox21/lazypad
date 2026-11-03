import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { client, health, makeEnv, postHook, rawRequest, sleep, startHub, tabState, waitFor } from "./helpers.js";

describe("erişim denetimi", () => {
  let e;
  before(async () => { e = await makeEnv(); await startHub(e); });
  after(() => e.cleanup());

  const rejected = (promise) => assert.rejects(promise, /401/);

  test("anahtarsız bağlantı reddedilir", async () => {
    await rejected(client(e, "/board", { token: "" }));
    await rejected(client(e, "/session", { token: "" }));
    await rejected(client(e, "/board", { token: "yanlis" }));
  });
  test("anahtar doğru olsa da başka origin giremez", async () => {
    await rejected(client(e, "/board", { origin: "http://evil.example" }));
    await rejected(client(e, "/board", { origin: "http://localhost:9999" }));
    await rejected(client(e, "/board", { origin: "null" }));
  });
  test("kendi origin'i ve anahtarı girer", async () => {
    const c = await client(e, "/board", { origin: e.base });
    const backlog = await c.seen((m) => m.type === "backlog", "backlog");
    assert.ok(backlog.build > 0, "tahta sürümü gelmeli");
    c.close();
  });
  test("anahtar adres parametresiyle de geçer (tarayıcı başlık gönderemez)", async () => {
    const c = await client(e, `/board?t=${e.token()}`, { token: "", origin: e.base });
    c.close();
  });
  test("yabancı Host reddedilir (DNS rebinding)", async () => {
    const host = (h) => ["POST /hook HTTP/1.1", `Host: ${h}`, `x-lazypad-token: ${e.token()}`, "Content-Length: 0", "Connection: close"];
    assert.match(await rawRequest(e, host("evil.example")), / 403 /);
    assert.match(await rawRequest(e, ["GET / HTTP/1.1", "Host: evil.example", "Connection: close"]), / 403 /);
    assert.match(await rawRequest(e, ["GET /health HTTP/1.1", "Host: evil.example:80", "Connection: close"]), / 403 /);
  });
  test("yazma uçları anahtar ister", async () => {
    for (const path of ["/hook", "/shutdown"]) {
      for (const headers of [{}, { "x-lazypad-token": "yanlis" }, { "x-lazypad": "1" }]) {
        assert.equal((await fetch(e.base + path, { method: "POST", headers })).status, 401, path);
      }
    }
    assert.ok(await health(e));
  });
  test("anahtar dosyası yalnızca kullanıcıya açık", async () => {
    const { statSync } = await import("node:fs");
    assert.equal(statSync(join(e.home, ".lazypad", "token")).mode & 0o777, 0o600);
  });
  test("tahta sayfası sıkı CSP ile gelir ve anahtar içermez", async () => {
    const r = await fetch(e.base + "/");
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    const html = await r.text();
    assert.ok(html.includes(`<script type="module" nonce="${nonce}">`));
    assert.ok(!html.includes(e.token()));
    assert.ok(!/cdn\.|https?:\/\/[a-z]+\.(net|com)/.test(html), "dış adres olmamalı");
  });
  test("Mermaid yerelden sunulur", async () => {
    const r = await fetch(e.base + "/vendor/mermaid.min.js");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /javascript/);
    assert.ok((await r.arrayBuffer()).byteLength > 1e6);
  });
});

describe("dayanıklılık", () => {
  let e, hub;
  before(async () => { e = await makeEnv(); hub = await startHub(e); });
  after(() => e.cleanup());

  test("bozuk WebSocket çerçevesi merkezi düşürmez", async () => {
    const board = await client(e, "/board");
    await new Promise((resolve, reject) => {
      const s = net.connect(e.port, "127.0.0.1", () => s.write([
        "GET /board HTTP/1.1", `Host: 127.0.0.1:${e.port}`, "Upgrade: websocket", "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", `x-lazypad-token: ${e.token()}`, "", "",
      ].join("\r\n")));
      s.once("data", () => { s.write(Buffer.from([0xff, 0xff, 0xff, 0xff])); setTimeout(resolve, 100); });
      s.on("error", reject);
    });
    assert.ok(await health(e));
    assert.equal(hub.exitCode, null);
    board.close();
  });
  test("geçersiz JSON ve garip adresler merkezi düşürmez", async () => {
    const c = await client(e, "/session");
    c.send("{bozuk");
    c.json({ type: "bilinmeyen" });
    c.close();
    assert.match(await rawRequest(e, ["GET // HTTP/1.1", `Host: 127.0.0.1:${e.port}`, "Connection: close"]), / 403 /);
    await fetch(e.base + "/hook", { method: "POST", headers: { "x-lazypad-token": e.token() }, body: "{bozuk" });
    assert.ok(await health(e));
  });
  test("port doluyken ikinci merkez sessizce çıkar", async () => {
    const { spawn } = await import("node:child_process");
    const { ENTRY } = await import("./helpers.js");
    const p = spawn(process.execPath, [ENTRY, "hub"], { env: e.env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => { err += c; });
    const code = await new Promise((r) => p.on("exit", r));
    assert.equal(code, 0);
    assert.equal(err, "");
  });
  test("bölünmüş çok baytlı karakterler bozulmaz", async () => {
    const board = await client(e, "/board");
    const body = Buffer.from(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: "/p/utf", session_id: "s", prompt: "şğüçöıİ çiz" }));
    const cut = body.indexOf(Buffer.from("ğ")) + 1; // ğ'nin ortasından böl
    await new Promise((resolve, reject) => {
      const s = net.connect(e.port, "127.0.0.1", async () => {
        s.write(`POST /hook HTTP/1.1\r\nHost: 127.0.0.1:${e.port}\r\nx-lazypad-token: ${e.token()}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
        s.write(body.subarray(0, cut));
        await sleep(30);
        s.write(body.subarray(cut));
      });
      s.resume();
      s.on("close", resolve);
      s.on("error", reject);
    });
    const ev = await board.seen((m) => m.type === "prompt" && m.tab === "/p/utf", "prompt");
    assert.equal(ev.text, "şğüçöıİ çiz");
    board.close();
  });
});

describe("sekme durumu", () => {
  let e, board;
  before(async () => { e = await makeEnv(); await startHub(e); board = await client(e, "/board"); });
  after(async () => { board.close(); await e.cleanup(); });
  const hook = (event, extra = {}) => postHook(e, { hook_event_name: event, session_id: "s1", ...extra });
  const state = (key, want) => waitFor(() => tabState(board, key) === want, `${key} → ${want}`);

  test("cd alt dizine geçince sekme bölünmez, tur bitince boşa döner", async () => {
    const project_dir = "/p/app";
    await hook("UserPromptSubmit", { project_dir, cwd: "/p/app", prompt: "selam" });
    await state("/p/app", "working");
    await hook("PostToolUse", { project_dir, cwd: "/p/app/src", tool_name: "Bash", tool_input: {} });
    await hook("Stop", { project_dir, cwd: "/p/app/src", last_assistant_message: "Bitti." });
    await state("/p/app", "idle");
    assert.equal(board.msgs.some((m) => m.type === "tab" && m.tab.key === "/p/app/src"), false);
  });
  test("API hatasında sekme boşa döner, kullanıcı uyarılır", async () => {
    const project_dir = "/p/fail";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await state(project_dir, "working");
    await hook("StopFailure", { project_dir, error: "rate_limit" });
    await state(project_dir, "idle");
    const ev = await board.seen((m) => m.type === "say" && m.tab === project_dir, "uyarı");
    assert.equal(ev.level, "warn");
    assert.match(ev.text, /istek sınırı/);
  });
  test("oturum bitince sekme boşa döner", async () => {
    const project_dir = "/p/end";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await state(project_dir, "working");
    await hook("SessionEnd", { project_dir, reason: "other" });
    await state(project_dir, "idle");
  });
  test("Esc ile kesilen tur boşa döner", async () => {
    const project_dir = "/p/esc";
    const transcript_path = join(e.home, "esc.jsonl");
    writeFileSync(transcript_path, JSON.stringify({ type: "user", message: { content: "x" } }) + "\n");
    await hook("UserPromptSubmit", { project_dir, prompt: "x", transcript_path });
    await state(project_dir, "working");
    appendFileSync(transcript_path, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n");
    await state(project_dir, "idle");
    await board.seen((m) => m.type === "stopped" && m.tab === project_dir, "durduruldu kartı");
  });
  test("önceki turdan kalan kesinti yeni turu durdurmaz", async () => {
    const project_dir = "/p/esc2";
    const transcript_path = join(e.home, "esc2.jsonl");
    const old = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n";
    writeFileSync(transcript_path, old);
    await hook("UserPromptSubmit", { project_dir, prompt: "devam", transcript_path });
    appendFileSync(transcript_path, JSON.stringify({ type: "queue-operation" }) + "\n");
    await sleep(200);
    assert.equal(tabState(board, project_dir), "working");
    await hook("Stop", { project_dir, last_assistant_message: "Tamam." });
  });
  test("izin bildirimi turuncu yapar, araç çalışınca (hangisi olursa olsun) mora döner", async () => {
    const project_dir = "/p/perm";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await hook("Notification", { project_dir, notification_type: "permission_prompt", message: "Claude needs your permission to use WebFetch" });
    await state(project_dir, "waiting");
    await hook("PostToolUse", { project_dir, tool_name: "WebFetch", tool_input: {} });
    await state(project_dir, "working");
    await hook("Stop", { project_dir, last_assistant_message: "Tamam." });
    await state(project_dir, "idle");
  });
  test("reddedilen araç (başarısız) da turuncuyu kaldırır", async () => {
    const project_dir = "/p/permf";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await hook("Notification", { project_dir, notification_type: "permission_prompt", message: "m" });
    await state(project_dir, "waiting");
    await hook("PostToolUseFailure", { project_dir, tool_name: "Bash", tool_input: {}, error: "x" });
    await state(project_dir, "working");
    await hook("Stop", { project_dir, last_assistant_message: "Tamam." });
  });
  test("boşta bekleme bildirimi sessizdir", async () => {
    const project_dir = "/p/idle";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await hook("Stop", { project_dir, last_assistant_message: "Tamam." });
    await state(project_dir, "idle");
    await hook("Notification", { project_dir, notification_type: "idle_prompt", message: "Claude is waiting for your input" });
    await sleep(50);
    assert.equal(tabState(board, project_dir), "idle");
    assert.equal(board.msgs.some((m) => m.type === "attention" && m.tab === project_dir), false);
  });
  test("Stop'tan sonra işlenen geç araç olayı sekmeyi yeniden mor yapmaz", async () => {
    const project_dir = "/p/late";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await hook("Stop", { project_dir, last_assistant_message: "Tamam." });
    await state(project_dir, "idle");
    await hook("PostToolUse", { project_dir, tool_name: "Read", tool_input: {} });
    await sleep(50);
    assert.equal(tabState(board, project_dir), "idle");
  });
  test("alt ajan araçları durumu değiştirmez ama etkinlikte görünür", async () => {
    const project_dir = "/p/sub";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await hook("Notification", { project_dir, notification_type: "permission_prompt", message: "m" });
    await state(project_dir, "waiting");
    await hook("PostToolUse", { project_dir, agent_id: "a1", tool_name: "Bash", tool_input: {} });
    await board.seen((m) => m.type === "activity" && m.tab === project_dir && m.cmds === 1, "etkinlik");
    assert.equal(tabState(board, project_dir), "waiting");
    await hook("Stop", { project_dir, last_assistant_message: "Tamam." });
  });
  test("aynı projede iki oturum: biri bitince diğeri çalışıyor kalır", async () => {
    const project_dir = "/p/two";
    await postHook(e, { hook_event_name: "UserPromptSubmit", session_id: "a", project_dir, prompt: "x" });
    await postHook(e, { hook_event_name: "UserPromptSubmit", session_id: "b", project_dir, prompt: "y" });
    await postHook(e, { hook_event_name: "Stop", session_id: "a", project_dir, last_assistant_message: "Tamam." });
    await sleep(50);
    assert.equal(tabState(board, project_dir), "working");
    await postHook(e, { hook_event_name: "Stop", session_id: "b", project_dir, last_assistant_message: "Tamam." });
    await state(project_dir, "idle");
  });
  test("oturum beklenmedik kapanırsa sekme takılmaz", async () => {
    const project_dir = "/p/crash";
    const s = await client(e, "/session");
    s.json({ type: "hello", cwd: project_dir });
    await board.seen((m) => m.type === "tab" && m.tab.key === project_dir, "sekme");
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await state(project_dir, "working");
    s.close();
    await state(project_dir, "idle");
  });
  test("boştaki sekme kapatılır, çalışan kapatılmaz; olay gelince geri açılır", async () => {
    const project_dir = "/p/close";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await state(project_dir, "working");
    board.json({ type: "close_tab", key: project_dir });
    await sleep(50);
    assert.equal(board.msgs.some((m) => m.type === "tab_closed" && m.key === project_dir), false);
    await hook("Stop", { project_dir, last_assistant_message: "Tamam." });
    await state(project_dir, "idle");
    board.json({ type: "close_tab", key: project_dir });
    await board.seen((m) => m.type === "tab_closed" && m.key === project_dir, "kapanma");
    const fresh = await client(e, "/board");
    const backlog = await fresh.seen((m) => m.type === "backlog", "backlog");
    assert.equal(backlog.tabs.some((t) => t.key === project_dir), false);
    assert.equal(backlog.events.some((ev) => ev.tab === project_dir), false);
    fresh.close();
  });
  test("cevabın bütün bölümleri tablosuyla birlikte tahtaya gelir", async () => {
    const project_dir = "/p/table";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await hook("Stop", { project_dir, last_assistant_message: "Komutlar hazır ve denendi.\n\n**Sorun yoğun yerlerde:** Taksim kalabalık.\n\n**Çözüm:**\n1. Bir\n2. İki\n\n| Ne | Nasıl |\n|---|---|\n| Kapat | `Cmd+Q` |" });
    const done = await board.seen((m) => m.type === "done" && m.tab === project_dir, "bitti");
    assert.equal(done.summary, "Komutlar hazır ve denendi.");
    assert.equal(done.blocks.map((b) => b.t).join(" "), "p h p h ol table");
    assert.equal(done.blocks[1].text, "Sorun yoğun yerlerde");
    assert.deepEqual(done.blocks[4].items, ["Bir", "İki"]);
    assert.deepEqual(done.blocks[5].rows, [["Kapat", "Cmd+Q"]]);
    assert.equal(done.question, null);
    await state(project_dir, "idle");
  });
  test("cevap soruyla bitince sekme sen yazana kadar seni bekler", async () => {
    const project_dir = "/p/question";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await hook("Stop", { project_dir, last_assistant_message: "Ölçüm bitti.\n\nÖlçmeye başlayayım mı?" });
    const done = await board.seen((m) => m.type === "done" && m.tab === project_dir, "bitti");
    assert.equal(done.question, "Ölçmeye başlayayım mı?");
    assert.equal(done.blocks.some((b) => b.text?.includes("başlayayım")), false, "soru metinde tekrar etmemeli");
    await state(project_dir, "waiting");
    await hook("PostToolUse", { project_dir, tool_name: "Read", tool_input: {} }); // Stop'tan sonra geç gelen olay
    await sleep(50);
    assert.equal(tabState(board, project_dir), "waiting");
    await hook("UserPromptSubmit", { project_dir, prompt: "evet" });
    await state(project_dir, "working");
    await hook("Stop", { project_dir, last_assistant_message: "Tamam, bitti." });
    await state(project_dir, "idle");
  });
  test("aynı tablo hem show ile hem sohbette verildiyse tahtada bir kez görünür", async () => {
    const project_dir = "/p/dedupe";
    const s = await client(e, "/session");
    s.json({ type: "hello", cwd: project_dir });
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    s.json({ type: "show", kind: "table", title: "Komutlar", data: { columns: ["Ne", "Nasıl"], rows: [["a", "b"]] } });
    await board.seen((m) => m.type === "show" && m.tab === project_dir, "show");
    const answer = "Komutlar hazır.\n\n| Ne | Nasıl |\n|---|---|\n| a | b |\n\n| Başka | Tablo |\n|---|---|\n| c | d |";
    assert.match(await hook("Stop", { project_dir, last_assistant_message: answer }), /"decision":"block"/, "tablolu cevap özet ister");
    await hook("Stop", { project_dir, stop_hook_active: true, last_assistant_message: answer });
    const done = await board.seen((m) => m.type === "done" && m.tab === project_dir, "bitti");
    assert.equal(board.msgs.filter((m) => m.type === "show" && m.tab === project_dir).length, 1);
    assert.deepEqual(done.blocks.filter((b) => b.t === "table").map((b) => b.columns[0]), ["Başka"]);
    s.close();
  });
  test("etkinlik kartı dosyaları proje köküne göre gösterir", async () => {
    const project_dir = "/p/files";
    await hook("UserPromptSubmit", { project_dir, prompt: "x" });
    await hook("PostToolUse", { project_dir, cwd: "/p/files/src", tool_name: "Edit", tool_input: { file_path: "/p/files/src/a.js" } });
    const ev = await board.seen((m) => m.type === "activity" && m.tab === project_dir, "etkinlik");
    assert.deepEqual(ev.files, ["src/a.js"]);
    await hook("Stop", { project_dir, last_assistant_message: "Tamam." });
  });
});

describe("geçmiş", () => {
  let e;
  before(async () => { e = await makeEnv(); await startHub(e); });
  after(() => e.cleanup());

  test("bir projenin kalabalığı diğerinin geçmişini silmez", async () => {
    await postHook(e, { hook_event_name: "UserPromptSubmit", session_id: "q", project_dir: "/p/quiet", prompt: "önemli" });
    await postHook(e, { hook_event_name: "Stop", session_id: "q", project_dir: "/p/quiet", last_assistant_message: "Tamam." });
    const s = await client(e, "/session");
    s.json({ type: "hello", cwd: "/p/noisy" });
    for (let i = 0; i < 1500; i++) s.json({ type: "say", text: `n${i}`, level: "ok" });
    const board = await client(e, "/board");
    await sleep(100);
    const fresh = await client(e, "/board");
    const { events } = await fresh.seen((m) => m.type === "backlog", "backlog");
    assert.ok(events.some((ev) => ev.tab === "/p/quiet" && ev.type === "prompt"));
    const noisy = events.filter((ev) => ev.tab === "/p/noisy");
    assert.ok(noisy.length > 0 && noisy.length <= 1000, String(noisy.length));
    s.close(); board.close(); fresh.close();
  });
});

describe("kararlar", () => {
  let e, board;
  before(async () => { e = await makeEnv(); await startHub(e); board = await client(e, "/board"); });
  after(async () => { board.close(); await e.cleanup(); });

  const session = async (cwd) => {
    const s = await client(e, "/session");
    s.json({ type: "hello", cwd });
    await waitFor(() => tabState(board, cwd), "sekme");
    return s;
  };
  const askMsg = (id) => ({ type: "ask", id, question: "Silinsin mi?", options: ["Hayır", "Evet"] });
  const answered = (id) => (m) => m.type === "answer" && m.id === id;

  test("cevap sahibine ulaşır, sekme durumu geri döner", async () => {
    const s = await session("/a/normal");
    s.json(askMsg("a1"));
    await waitFor(() => tabState(board, "/a/normal") === "waiting", "bekliyor");
    board.json({ type: "answer", id: "a1", choice: "Evet" });
    assert.equal((await s.seen(answered("a1"), "cevap")).choice, "Evet");
    await board.seen((m) => m.type === "answered" && m.askId === "a1", "answered");
    await waitFor(() => tabState(board, "/a/normal") === "idle", "boşta");
    s.close();
  });
  test("seçeneklerde olmayan cevap yok sayılır", async () => {
    const s = await session("/a/invalid");
    s.json(askMsg("a2"));
    await board.seen((m) => m.type === "ask" && m.id === "a2", "kart");
    board.json({ type: "answer", id: "a2", choice: "Sahte" });
    board.json({ type: "answer", id: "a2", choices: ["Evet"] }); // çoklu seçim açık değil
    board.json({ type: "answer", id: "a2", text: "   " });
    await sleep(50);
    assert.equal(s.msgs.some(answered("a2")), false);
    assert.equal(board.msgs.some((m) => m.type === "answered" && m.askId === "a2"), false);
    board.json({ type: "answer", id: "a2", choice: "Hayır" });
    await s.seen(answered("a2"), "cevap");
    s.close();
  });
  test("koptuktan sonra verilen cevap yeniden bağlanınca ulaşır", async () => {
    const s1 = await session("/a/reconnect");
    s1.json(askMsg("a3"));
    await board.seen((m) => m.type === "ask" && m.id === "a3", "kart");
    s1.close();
    await sleep(30);
    board.json({ type: "answer", id: "a3", choice: "Hayır" });
    await board.seen((m) => m.type === "answered" && m.askId === "a3", "answered");
    const s2 = await session("/a/reconnect");
    s2.json(askMsg("a3"));
    assert.equal((await s2.seen(answered("a3"), "cevap")).choice, "Hayır");
    assert.equal(board.msgs.filter((m) => m.type === "ask" && m.id === "a3").length, 1, "kart çoğalmamalı");
    s2.close();
  });
  test("yeniden bağlanan oturum kartı çoğaltmaz, cevabı alır", async () => {
    const s1 = await session("/a/rebind");
    s1.json(askMsg("a4"));
    await board.seen((m) => m.type === "ask" && m.id === "a4", "kart");
    s1.close();
    await sleep(30);
    const s2 = await session("/a/rebind");
    s2.json(askMsg("a4"));
    await sleep(30);
    board.json({ type: "answer", id: "a4", choice: "Evet" });
    await s2.seen(answered("a4"), "cevap");
    assert.equal(board.msgs.filter((m) => m.type === "ask" && m.id === "a4").length, 1);
    s2.close();
  });
  test("oturum geri dönmezse kart kapanır, sekme bekliyor kalmaz", async () => {
    const s = await session("/a/gone");
    s.json(askMsg("a5"));
    await waitFor(() => tabState(board, "/a/gone") === "waiting", "bekliyor");
    s.close();
    const ev = await board.seen((m) => m.type === "ask_closed" && m.askId === "a5", "kapanma");
    assert.equal(ev.reason, "session");
    await waitFor(() => tabState(board, "/a/gone") === "idle", "boşta");
  });
  test("zaman aşımı kartı kapatır, geç cevap yok sayılır", async () => {
    const s = await session("/a/timeout");
    s.json(askMsg("a6"));
    await waitFor(() => tabState(board, "/a/timeout") === "waiting", "bekliyor");
    s.json({ type: "ask_cancel", id: "a6", reason: "timeout" });
    const ev = await board.seen((m) => m.type === "ask_closed" && m.askId === "a6", "kapanma");
    assert.equal(ev.reason, "timeout");
    await waitFor(() => tabState(board, "/a/timeout") === "idle", "boşta");
    board.json({ type: "answer", id: "a6", choice: "Evet" });
    await sleep(50);
    assert.equal(s.msgs.some(answered("a6")), false);
    assert.equal(board.msgs.some((m) => m.type === "answered" && m.askId === "a6"), false);
    s.close();
  });
  test("bekleyen karar geçmişle birlikte yeni tahtaya gelir", async () => {
    const s = await session("/a/backlog");
    s.json(askMsg("a7"));
    await board.seen((m) => m.type === "ask" && m.id === "a7", "kart");
    const fresh = await client(e, "/board");
    const backlog = await fresh.seen((m) => m.type === "backlog", "backlog");
    assert.ok(backlog.events.some((ev) => ev.type === "ask" && ev.id === "a7"));
    assert.equal(backlog.tabs.find((t) => t.key === "/a/backlog").state, "waiting");
    fresh.json({ type: "answer", id: "a7", choice: "Evet" });
    await s.seen(answered("a7"), "cevap");
    fresh.close(); s.close();
  });
});

describe("kapatma", () => {
  test("/shutdown oturumlara haber verir ve çıkar", async () => {
    const e = await makeEnv();
    const hub = await startHub(e);
    const s = await client(e, "/session");
    const r = await fetch(e.base + "/shutdown", { method: "POST", headers: { "x-lazypad-token": e.token() } });
    assert.equal(r.status, 200);
    await s.seen((m) => m.type === "shutdown", "haber");
    assert.deepEqual(await hub.done, { code: 0, signal: null });
    await e.cleanup();
  });
});
