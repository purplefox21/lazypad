// Tahtadan Claude'a giden her yol: yazı, izin, seçenekli soru, plan. Claude yerine hook süreçlerinin aynısı kullanılır.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ENTRY, client, health, makeEnv, postHook, sleep, startHub, tabState, waitFor } from "./helpers.js";

/** Gerçek hook sürecini çalıştırır: çıkış kodu, stdout ve stderr döner. */
function runHook(e, sub, input, { project = input.project_dir } = {}) {
  const p = e.track(spawn(process.execPath, [ENTRY, sub], { env: { ...e.env, CLAUDE_PROJECT_DIR: project }, stdio: ["pipe", "pipe", "pipe"] }));
  let stdout = "", stderr = "";
  p.stdout.on("data", (c) => { stdout += c; });
  p.stderr.on("data", (c) => { stderr += c; });
  p.stdin.end(JSON.stringify(input));
  p.done = new Promise((r) => p.on("exit", (code) => r({ code, stdout, stderr })));
  return p;
}

describe("tahtadan yazı", () => {
  let e, board;
  before(async () => { e = await makeEnv(); await startHub(e); board = await client(e, "/board"); });
  after(async () => { board.close(); await e.cleanup(); });
  const hook = (event, project_dir, extra = {}) => postHook(e, { hook_event_name: event, session_id: project_dir, project_dir, ...extra });
  const promptEv = (key, text) => board.msgs.findLast((m) => m.type === "prompt" && m.tab === key && m.text === text);

  test("Claude boştayken yazı oturumu uyandırır: hook 2 ile çıkar, metin stderr'e gider", async () => {
    const project_dir = "/b/idle";
    await hook("UserPromptSubmit", project_dir, { prompt: "x" });
    await hook("Stop", project_dir, { last_assistant_message: "İlk cevap burada." });
    const waiter = runHook(e, "wait", { session_id: project_dir, hook_event_name: "Stop" }, { project: project_dir });
    await waitFor(async () => (await health(e)).waiters === 1, "bekleyen hook");
    board.json({ type: "reply", tab: project_dir, text: "şunu da yap" });
    const r = await waiter.done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Lazypad board/);
    assert.match(r.stderr, /şunu da yap/);
    await waitFor(() => promptEv(project_dir, "şunu da yap")?.delivery === "sent", "iletildi");
    assert.equal(promptEv(project_dir, "şunu da yap").fromBoard, true);
    await waitFor(() => tabState(board, project_dir) === "working", "çalışıyor");
    await hook("Stop", project_dir, { last_assistant_message: "Yaptım, bitti." });
  });
  test("Uyanma bildirimi kart olmaz, ek bloklar kullanıcının mesajını gizlemez", async () => {
    const project_dir = "/b/clean";
    await hook("UserPromptSubmit", project_dir, { prompt: "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>" });
    await hook("UserPromptSubmit", project_dir, { prompt: "<browser_instruction>uzun talimat</browser_instruction>asıl mesajım" });
    await waitFor(() => board.msgs.some((m) => m.type === "prompt" && m.tab === project_dir), "prompt");
    assert.deepEqual(board.msgs.filter((m) => m.type === "prompt" && m.tab === project_dir).map((m) => m.text), ["asıl mesajım"]);
    await hook("Stop", project_dir, { last_assistant_message: "Tamam." });
  });
  test("Merkez yeni açıldıysa yazı düşmez: oturum dönünce iletilir", async () => {
    const project_dir = "/b/rejoin";
    board.json({ type: "reply", tab: (await waitFor(async () => { await hook("SessionEnd", project_dir, { reason: "other" }); return project_dir; }, "sekme")), text: "bekle beni" });
    await waitFor(() => promptEv(project_dir, "bekle beni")?.delivery === "queued", "sırada");
    const waiter = runHook(e, "wait", { session_id: project_dir, hook_event_name: "Stop" }, { project: project_dir });
    const r = await waiter.done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /bekle beni/);
    assert.equal(promptEv(project_dir, "bekle beni").delivery, "sent");
    await hook("Stop", project_dir, { last_assistant_message: "Tamam." });
  });
  test("Yazı hook'tan önce geldiyse hook başlar başlamaz teslim alır", async () => {
    const project_dir = "/b/early";
    const s = await client(e, "/session");
    s.json({ type: "hello", cwd: project_dir });
    await waitFor(() => tabState(board, project_dir), "sekme");
    board.json({ type: "reply", tab: project_dir, text: "erken yazı" });
    await waitFor(() => promptEv(project_dir, "erken yazı")?.delivery === "queued", "sırada");
    const waiter = runHook(e, "wait", { session_id: project_dir, hook_event_name: "Stop" }, { project: project_dir });
    const r = await waiter.done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /erken yazı/);
    s.close();
  });
  test("Yeni bekleyen hook gelince eskisi sessizce çıkar, hook'lar birikmez", async () => {
    const project_dir = "/b/vscode";
    const before = (await health(e)).waiters;
    const waiter = runHook(e, "wait", { session_id: project_dir, hook_event_name: "Stop" }, { project: project_dir });
    await waitFor(async () => (await health(e)).waiters === before + 1, "bekleyen hook");
    const next = runHook(e, "wait", { session_id: project_dir, hook_event_name: "UserPromptSubmit" }, { project: project_dir });
    assert.equal((await waiter.done).code, 0);
    await waitFor(async () => (await health(e)).waiters === before + 1, "tek hook");
    await hook("SessionEnd", project_dir, { reason: "other" });
    assert.equal((await next.done).code, 0);
  });
  test("Claude çalışırken bekleyen hook uyandırmaz; Esc'ten sonra yazı oturumu uyandırır", async () => {
    const project_dir = "/b/esc";
    const transcript_path = join(e.home, "besc.jsonl");
    writeFileSync(transcript_path, "");
    await hook("UserPromptSubmit", project_dir, { prompt: "uzun iş", transcript_path });
    const waiter = runHook(e, "wait", { session_id: project_dir, hook_event_name: "UserPromptSubmit", transcript_path }, { project: project_dir });
    await sleep(250);
    board.json({ type: "reply", tab: project_dir, text: "dur şunu yap" });
    await waitFor(() => promptEv(project_dir, "dur şunu yap")?.delivery === "queued", "sırada");
    await sleep(100);
    assert.equal(waiter.exitCode, null, "çalışırken uyandırmamalı");
    appendFileSync(transcript_path, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n");
    const r = await waiter.done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /dur şunu yap/);
    await hook("Stop", project_dir, { last_assistant_message: "Tamam." });
  });
  test("Oturum bitince bekleyen hook çıkar", async () => {
    const project_dir = "/b/ended";
    const waiter = runHook(e, "wait", { session_id: project_dir, hook_event_name: "Stop" }, { project: project_dir });
    await sleep(300);
    await hook("SessionEnd", project_dir, { reason: "other" });
    assert.equal((await waiter.done).code, 0);
  });
  test("Claude çalışırken yazı bir sonraki araçta iletilir", async () => {
    const project_dir = "/b/running";
    await hook("UserPromptSubmit", project_dir, { prompt: "x" });
    board.json({ type: "reply", tab: project_dir, text: "araya giriyorum" });
    await waitFor(() => promptEv(project_dir, "araya giriyorum")?.delivery === "queued", "sırada");
    const out = JSON.parse(await hook("PostToolUse", project_dir, { tool_name: "Read", tool_input: {} }));
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /araya giriyorum/);
    await waitFor(() => promptEv(project_dir, "araya giriyorum")?.delivery === "sent", "iletildi");
    assert.equal(await hook("PostToolUse", project_dir, { tool_name: "Read", tool_input: {} }), "", "ikinci kez iletilmemeli");
    await hook("Stop", project_dir, { last_assistant_message: "Tamam." });
  });
  test("Tur biterken sıradaki yazı Claude'u devam ettirir", async () => {
    const project_dir = "/b/stopblock";
    await hook("UserPromptSubmit", project_dir, { prompt: "x" });
    board.json({ type: "reply", tab: project_dir, text: "bir de bunu yap" });
    await waitFor(() => promptEv(project_dir, "bir de bunu yap"), "sırada");
    const out = JSON.parse(await hook("Stop", project_dir, { last_assistant_message: "Bitirdim, devam edeyim mi?" }));
    assert.equal(out.decision, "block");
    assert.match(out.reason, /bir de bunu yap/);
    await board.seen((m) => m.type === "done" && m.tab === project_dir, "bitti kartı");
    await waitFor(() => tabState(board, project_dir) === "working", "devam ediyor");
    await hook("Stop", project_dir, { last_assistant_message: "Onu da yaptım." });
    await waitFor(() => tabState(board, project_dir) === "idle", "boşta");
  });
  test("İstemle birlikte de iletilir", async () => {
    const project_dir = "/b/withprompt";
    const s = await client(e, "/session");
    s.json({ type: "hello", cwd: project_dir });
    await waitFor(() => tabState(board, project_dir), "sekme");
    board.json({ type: "reply", tab: project_dir, text: "not düşüyorum" });
    await waitFor(() => promptEv(project_dir, "not düşüyorum"), "sırada");
    const out = JSON.parse(await hook("UserPromptSubmit", project_dir, { prompt: "devam" }));
    assert.match(out.hookSpecificOutput.additionalContext, /not düşüyorum/);
    assert.match(out.hookSpecificOutput.additionalContext, /Explanation mode/);
    s.close();
    await hook("Stop", project_dir, { last_assistant_message: "Tamam." });
  });
  test("Açık oturum yoksa yazı iletilemedi olarak işaretlenir", async () => {
    const project_dir = "/b/closed";
    await hook("UserPromptSubmit", project_dir, { prompt: "x" });
    await hook("SessionEnd", project_dir, { reason: "other" });
    board.json({ type: "reply", tab: project_dir, text: "kimse yok" });
    await waitFor(() => promptEv(project_dir, "kimse yok")?.delivery === "failed", "iletilemedi");
  });
  test("Tek tıklık cevap seçenekleri gelir", async () => {
    const project_dir = "/b/quick";
    await hook("UserPromptSubmit", project_dir, { prompt: "x" });
    await hook("Stop", project_dir, { last_assistant_message: "Ölçüm bitti.\n\nÖlçmeye başlayayım mı?" });
    const done = await board.seen((m) => m.type === "done" && m.tab === project_dir, "bitti");
    assert.deepEqual(done.quick, ["Evet", "Hayır"]);
    await hook("UserPromptSubmit", project_dir, { prompt: "y" });
    await hook("Stop", project_dir, { last_assistant_message: "Bir karar lazım.\n\nHangisini seçelim?\n\n1. Hızlı yol\n2. **Sağlam** yol" });
    const second = await waitFor(() => board.msgs.findLast((m) => m.type === "done" && m.tab === project_dir && m.question === "Hangisini seçelim?"), "ikinci");
    assert.deepEqual(second.quick, ["Hızlı yol", "Sağlam yol"]);
    assert.equal(second.blocks.at(-1).t, "ol", "seçenekler cevapta da durmalı");
  });
});

describe("izin, seçenekli soru ve plan", () => {
  let e, board;
  before(async () => { e = await makeEnv(); await startHub(e); board = await client(e, "/board"); });
  after(async () => { board.close(); await e.cleanup(); });
  const need = (kind) => board.seen((m) => m.type === "need" && m.kind === kind && !board.msgs.some((c) => c.type === "need_closed" && c.needId === m.id), `${kind} kartı`);
  const hook = (event, project_dir, extra = {}) => postHook(e, { hook_event_name: event, session_id: project_dir, project_dir, ...extra });
  const perm = (project_dir, tool_name, tool_input) => runHook(e, "hook", { hook_event_name: "PermissionRequest", session_id: project_dir, tool_name, tool_input }, { project: project_dir });
  const decision = (r) => JSON.parse(r.stdout).hookSpecificOutput.decision;

  test("İzin verilince hook allow döner, sekme turuncudan çıkar", async () => {
    const key = "/n/allow";
    await hook("UserPromptSubmit", key, { prompt: "x" });
    const p = perm(key, "Bash", { command: "npm run lint", description: "Lint çalıştır" });
    const card = await need("permission");
    assert.equal(card.tool, "Bash");
    assert.equal(card.title, "Lint çalıştır");
    assert.equal(card.detail, "npm run lint");
    await waitFor(() => tabState(board, key) === "waiting", "turuncu");
    board.json({ type: "decide", id: card.id, allow: true });
    const r = await p.done;
    assert.equal(r.code, 0);
    assert.deepEqual(decision(r), { behavior: "allow" });
    await waitFor(() => tabState(board, key) === "working", "mor");
    const closed = await board.seen((m) => m.type === "need_closed" && m.needId === card.id, "kapandı");
    assert.equal(closed.by, "board");
    await hook("Stop", key, { last_assistant_message: "Tamam." });
  });
  test("Reddedilince neden Claude'a gider", async () => {
    const key = "/n/deny";
    const p = perm(key, "Bash", { command: "rm -rf build" });
    const card = await need("permission");
    board.json({ type: "decide", id: card.id, allow: false, message: "önce yedek al" });
    const d = decision(await p.done);
    assert.equal(d.behavior, "deny");
    assert.match(d.message, /önce yedek al/);
  });
  test("VS Code'dan cevaplanınca (araç çalışınca) kart kapanır, hook çıkar", async () => {
    const key = "/n/elsewhere";
    await hook("UserPromptSubmit", key, { prompt: "x" });
    const p = perm(key, "Bash", { command: "touch a" });
    const card = await need("permission");
    await hook("PostToolUse", key, { tool_name: "Bash", tool_input: { command: "touch a" } });
    const r = await p.done;
    assert.equal(r.stdout, "", "karar verilmemeli");
    const closed = await board.seen((m) => m.type === "need_closed" && m.needId === card.id, "kapandı");
    assert.equal(closed.by, "elsewhere");
    await waitFor(() => tabState(board, key) === "working", "mor");
    await hook("Stop", key, { last_assistant_message: "Tamam." });
  });
  test("Tur biterse açık izin kartı kapanır", async () => {
    const key = "/n/stop";
    const p = perm(key, "Bash", { command: "touch b" });
    const card = await need("permission");
    await hook("Stop", key, { last_assistant_message: "Vazgeçtim." });
    assert.equal((await p.done).stdout, "");
    await board.seen((m) => m.type === "need_closed" && m.needId === card.id, "kapandı");
    await waitFor(() => tabState(board, key) === "idle", "boşta");
  });
  test("Bilinmeyen karar yok sayılır, hook'un bağlantısı koparsa kart kapanır", async () => {
    const key = "/n/killed";
    board.json({ type: "decide", id: "yok", allow: true });
    const p = perm(key, "Bash", { command: "touch c" });
    const card = await need("permission");
    p.kill("SIGKILL");
    await board.seen((m) => m.type === "need_closed" && m.needId === card.id, "kapandı");
    assert.equal((await health(e)).needs, 0);
  });
  test("Seçenekli soru: cevap Claude'a ret değil cevap olarak gider", async () => {
    const key = "/n/question";
    const questions = [{ question: "Hangi renk?", header: "Renk", options: [{ label: "Mavi", description: "Serin" }, { label: "Kırmızı" }], multiSelect: false }];
    const p = perm(key, "AskUserQuestion", { questions });
    const card = await need("question");
    assert.deepEqual(card.questions, questions);
    board.json({ type: "decide", id: card.id, answers: { "Uydurma?": "x" } });
    await sleep(50);
    assert.equal((await health(e)).needs, 1, "bilinmeyen soru kabul edilmemeli");
    board.json({ type: "decide", id: card.id, answers: { "Hangi renk?": "Kırmızı" } });
    const d = decision(await p.done);
    assert.equal(d.behavior, "deny");
    assert.match(d.message, /not a refusal/);
    assert.match(d.message, /"Hangi renk\?" = "Kırmızı"/);
    const closed = await board.seen((m) => m.type === "need_closed" && m.needId === card.id, "kapandı");
    assert.equal(closed.text, "Cevabın: Kırmızı");
  });
  test("Seçenekli soru VS Code'dan cevaplanınca cevap kartta görünür", async () => {
    const key = "/n/qvscode";
    const questions = [{ question: "Hangi yol?", options: [{ label: "A" }, { label: "B" }], multiSelect: false }];
    const p = perm(key, "AskUserQuestion", { questions });
    const card = await need("question");
    await hook("PostToolUse", key, { tool_name: "AskUserQuestion", tool_input: { questions }, tool_response: { answers: { "Hangi yol?": "B" } } });
    assert.equal((await p.done).stdout, "");
    const closed = await board.seen((m) => m.type === "need_closed" && m.needId === card.id, "kapandı");
    assert.equal(closed.text, "B");
  });
  test("Açık soruyken yazı kutusu o sorunun cevabıdır", async () => {
    const key = "/n/qtyped";
    const questions = [{ question: "Hangi yol?", options: [{ label: "A" }], multiSelect: false }];
    const p = perm(key, "AskUserQuestion", { questions });
    await need("question");
    board.json({ type: "reply", tab: key, text: "ikisi de olmaz, C" });
    assert.match(decision(await p.done).message, /ikisi de olmaz, C/);
  });
  test("Plan: içerik kartta tam görünür, düzeltme isteği Claude'a gider", async () => {
    const key = "/n/plan";
    const p = perm(key, "ExitPlanMode", { plan: "## Plan\n\n1. Birinci adım\n2. İkinci adım" });
    const card = await need("plan");
    assert.equal(card.blocks.map((b) => b.t).join(" "), "h ol");
    board.json({ type: "decide", id: card.id });
    await sleep(50);
    assert.equal((await health(e)).needs, 1, "boş düzeltme kabul edilmemeli");
    board.json({ type: "decide", id: card.id, message: "ikinci adımı çıkar" });
    const d = decision(await p.done);
    assert.equal(d.behavior, "deny");
    assert.match(d.message, /ikinci adımı çıkar/);
  });
  test("Tahta kapalıyken hook hemen çıkar, kart kayıt olarak kalır", async () => {
    const e2 = await makeEnv();
    await startHub(e2);
    const p = runHook(e2, "hook", { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Bash", tool_input: { command: "x" } }, { project: "/n/noboard" });
    assert.equal((await p.done).stdout, "");
    const b = await client(e2, "/board");
    const { events } = await b.seen((m) => m.type === "backlog", "backlog");
    assert.ok(events.some((ev) => ev.type === "need"));
    assert.equal(events.find((ev) => ev.type === "need_closed").by, "noboard");
    b.close();
    await e2.cleanup();
  });
  test("Açık izin kartı varken gecikmeli izin bildirimi ikinci kart açmaz", async () => {
    const key = "/n/notif";
    const p = perm(key, "Bash", { command: "touch d" });
    const card = await need("permission");
    await hook("Notification", key, { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
    await sleep(50);
    assert.equal(board.msgs.some((m) => m.type === "attention" && m.tab === key), false);
    board.json({ type: "decide", id: card.id, allow: true });
    await p.done;
  });
});

describe("uzun cevabın tahta özeti", () => {
  let e, board;
  before(async () => { e = await makeEnv(); await startHub(e); board = await client(e, "/board"); });
  after(async () => { board.close(); await e.cleanup(); });
  const LONG = "Sonuç bu şekilde çıktı, ayrıntılar aşağıda.\n\n" + "Uzun açıklama cümlesi burada duruyor. ".repeat(30) + "\n\nÖlçmeye başlayayım mı?";
  const hook = (event, project_dir, extra = {}) => postHook(e, { hook_event_name: event, session_id: project_dir, project_dir, ...extra });
  const open = async (key) => {
    const s = await client(e, "/session");
    s.json({ type: "hello", cwd: key });
    await waitFor(() => tabState(board, key), "sekme");
    await hook("UserPromptSubmit", key, { prompt: "x" });
    return s;
  };

  test("uzun cevapta Claude'dan özet istenir; bitti kartı özetten sonra, asıl cevapla gelir", async () => {
    const key = "/c/long";
    const s = await open(key);
    const out = JSON.parse(await hook("Stop", key, { last_assistant_message: LONG }));
    assert.equal(out.decision, "block");
    assert.match(out.reason, /`page`/);
    await sleep(50);
    assert.equal(board.msgs.some((m) => m.type === "done" && m.tab === key), false, "bitti kartı henüz gelmemeli");
    assert.equal(tabState(board, key), "working");
    s.json({ type: "page", title: "Kısa sonuç", html: "<p class='lead'>Sonuç</p>" });
    await board.seen((m) => m.type === "page" && m.tab === key, "sayfa");
    assert.equal(await hook("Stop", key, { stop_hook_active: true, last_assistant_message: "Tahtaya koydum." }), "", "ikinci kez istenmemeli");
    const done = await board.seen((m) => m.type === "done" && m.tab === key, "bitti");
    assert.equal(done.summary, "Sonuç bu şekilde çıktı, ayrıntılar aşağıda.");
    assert.equal(done.question, "Ölçmeye başlayayım mı?");
    assert.match(JSON.stringify(done.blocks), /Uzun açıklama/, "tam metin düğmenin arkasında durmalı");
    assert.doesNotMatch(JSON.stringify(done.blocks), /Tahtaya koydum/);
    assert.ok(board.msgs.indexOf(board.msgs.find((m) => m.type === "page" && m.tab === key)) < board.msgs.indexOf(done));
    await waitFor(() => tabState(board, key) === "waiting", "soru: turuncu");
    s.close();
  });
  test("Turda başka bir sayfa çizildiyse de son cevabın özeti sorulur, Claude gerekmiyorsa yenisini çizmez", async () => {
    const key = "/c/already";
    const s = await open(key);
    s.json({ type: "page", title: "İki fotoğraf", html: "<p>x</p>" });
    await board.seen((m) => m.type === "page" && m.tab === key, "sayfa");
    const out = JSON.parse(await hook("Stop", key, { last_assistant_message: LONG }));
    assert.equal(out.decision, "block");
    assert.match(out.reason, /already drew/);
    assert.equal(await hook("Stop", key, { stop_hook_active: true, last_assistant_message: "" }), "");
    await board.seen((m) => m.type === "done" && m.tab === key, "bitti");
    s.close();
  });
  test("kısa cevap, Metin modu ve MCP'siz oturumda istenmez", async () => {
    const key = "/c/short";
    const s = await open(key);
    assert.equal(await hook("Stop", key, { last_assistant_message: "Tamam, bitti." }), "");
    s.close();
    await hook("UserPromptSubmit", "/c/nomcp", { prompt: "x" });
    assert.equal(await hook("Stop", "/c/nomcp", { last_assistant_message: LONG }), "", "aracı olmayan oturumdan istenmemeli");
    board.json({ type: "explain", mode: "text" });
    await board.seen((m) => m.type === "explain" && m.mode === "text", "mod");
    const s2 = await open("/c/text");
    assert.equal(await hook("Stop", "/c/text", { last_assistant_message: LONG }), "");
    s2.close();
    board.json({ type: "explain", mode: "visual" });
  });
  test("Claude özeti yazmadan bitirirse döngüye girmez, cevap kaybolmaz", async () => {
    const key = "/c/refuse";
    const s = await open(key);
    assert.match(await hook("Stop", key, { last_assistant_message: LONG }), /block/);
    assert.equal(await hook("Stop", key, { last_assistant_message: "" }), "");
    const done = await board.seen((m) => m.type === "done" && m.tab === key, "bitti");
    assert.match(JSON.stringify(done.blocks), /Uzun açıklama/);
    s.close();
  });
  test("asıl cevap ara mesaj olarak tekrar çıkmaz", async () => {
    const key = "/c/nonote";
    const transcript_path = join(e.home, "c.jsonl");
    writeFileSync(transcript_path, "");
    const line = (o) => JSON.stringify(o) + "\n";
    const s = await client(e, "/session");
    s.json({ type: "hello", cwd: key });
    await waitFor(() => tabState(board, key), "sekme");
    await hook("UserPromptSubmit", key, { prompt: "x", transcript_path });
    appendFileSync(transcript_path, line({ type: "assistant", message: { content: [{ type: "text", text: LONG }] } }));
    await sleep(120);
    assert.match(await hook("Stop", key, { last_assistant_message: LONG, transcript_path }), /block/);
    appendFileSync(transcript_path, line({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__lazypad__page", input: {} }] } }));
    s.json({ type: "page", title: "T", html: "<p>x</p>" });
    await sleep(150);
    await hook("Stop", key, { stop_hook_active: true, last_assistant_message: "", transcript_path });
    await board.seen((m) => m.type === "done" && m.tab === key, "bitti");
    assert.equal(board.msgs.some((m) => m.type === "note" && m.tab === key), false);
    s.close();
  });
  test("görselli sayfa diske görselsiz yazılır", async () => {
    const e2 = await makeEnv({ LAZYPAD_SAVE_MS: "20" });
    await startHub(e2);
    const s = await client(e2, "/session");
    s.json({ type: "hello", cwd: "/c/disk" });
    s.json({ type: "page", title: "T", html: `<img src="data:image/png;base64,AAAA"><p>metin</p>` });
    await sleep(120);
    const saved = JSON.parse(readFileSync(join(e2.home, ".lazypad", "history.json"), "utf8")).events["/c/disk"][0].html;
    assert.doesNotMatch(saved, /base64/);
    assert.match(saved, /metin/);
    s.close();
    await e2.cleanup();
  });
});

describe("kayıpsız akış", () => {
  let e, board;
  before(async () => { e = await makeEnv(); await startHub(e); board = await client(e, "/board"); });
  after(async () => { board.close(); await e.cleanup(); });
  const line = (o) => JSON.stringify(o) + "\n";
  const text = (t) => line({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const tool = (name) => line({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });

  test("Claude'un ara mesajları sırayla tahtaya gelir, son cevap iki kez çıkmaz", async () => {
    const key = "/k/notes";
    const transcript_path = join(e.home, "notes.jsonl");
    writeFileSync(transcript_path, text("önceki turdan kalan"));
    await postHook(e, { hook_event_name: "UserPromptSubmit", session_id: "s", project_dir: key, prompt: "x", transcript_path });
    appendFileSync(transcript_path, text("Önce ölçüyorum.") + tool("Bash"));
    await board.seen((m) => m.type === "note" && m.tab === key && m.blocks[0].text === "Önce ölçüyorum.", "ara mesaj");
    appendFileSync(transcript_path, text("Şimdi raporu yazıyorum.") + tool("Write"));
    await board.seen((m) => m.type === "note" && m.tab === key && m.blocks[0].text === "Şimdi raporu yazıyorum.", "ikinci ara mesaj");
    appendFileSync(transcript_path, text("Hepsi bitti, sonuç burada."));
    await sleep(120);
    await postHook(e, { hook_event_name: "Stop", session_id: "s", project_dir: key, transcript_path, last_assistant_message: "Hepsi bitti, sonuç burada." });
    await board.seen((m) => m.type === "done" && m.tab === key, "bitti");
    const notes = board.msgs.filter((m) => m.type === "note" && m.tab === key).map((m) => m.blocks[0].text);
    assert.deepEqual(notes, ["Önce ölçüyorum.", "Şimdi raporu yazıyorum."]);
  });
  test("Esc ile kesilen turun son mesajı da kaybolmaz", async () => {
    const key = "/k/esc";
    const transcript_path = join(e.home, "esc.jsonl");
    writeFileSync(transcript_path, "");
    await postHook(e, { hook_event_name: "UserPromptSubmit", session_id: "s", project_dir: key, prompt: "x", transcript_path });
    appendFileSync(transcript_path, text("Yarıda kalan mesaj.") + line({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
    await board.seen((m) => m.type === "stopped" && m.tab === key, "durduruldu");
    assert.ok(board.msgs.some((m) => m.type === "note" && m.tab === key && m.blocks[0].text === "Yarıda kalan mesaj."));
  });
  test("Merkez yeniden başlarken gelen yazı: bekleyen hook dönünce iletilir", async () => {
    const e2 = await makeEnv({ LAZYPAD_REJOIN_MS: "6000" });
    let hub = await startHub(e2);
    const key = "/k/restart";
    const waiter = runHook(e2, "wait", { session_id: "s", hook_event_name: "Stop" }, { project: key });
    await waitFor(async () => (await health(e2)).waiters === 1, "bekleyen hook");
    hub.kill("SIGTERM");
    await hub.done;
    hub = await startHub(e2); // bekleyen hook birkaç saniye içinde geri döner
    const b = await client(e2, "/board");
    await b.seen((m) => m.type === "backlog", "backlog");
    b.json({ type: "reply", tab: key, text: "evet" }); // sekme geçmişten geldi, oturum henüz dönmedi
    const r = await waiter.done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /evet/);
    const ev = await waitFor(() => b.msgs.findLast((m) => m.type === "prompt" && m.text === "evet" && m.delivery === "sent"), "iletildi");
    assert.equal(b.msgs.some((m) => m.type === "prompt" && m.delivery === "failed"), false, ev.text);
    b.close();
    await e2.cleanup();
  });
  test("Sırada kalan yazı yeniden başlatmada kaybolmaz, tekrar gönderilebilir biçimde kalır", async () => {
    const e2 = await makeEnv({ LAZYPAD_SAVE_MS: "20", LAZYPAD_REJOIN_MS: "60000" });
    const hub = await startHub(e2);
    await postHook(e2, { hook_event_name: "UserPromptSubmit", session_id: "s", project_dir: "/k/q", prompt: "x" });
    const b = await client(e2, "/board");
    b.json({ type: "reply", tab: "/k/q", text: "sırada kaldım" });
    await b.seen((m) => m.type === "prompt" && m.delivery === "queued", "sırada");
    await sleep(80);
    b.close();
    hub.kill("SIGTERM");
    await hub.done;
    await startHub(e2);
    const b2 = await client(e2, "/board");
    const { events } = await b2.seen((m) => m.type === "backlog", "backlog");
    assert.equal(events.find((ev) => ev.text === "sırada kaldım").delivery, "failed");
    b2.close();
    await e2.cleanup();
  });
  test("Geçmiş merkez yeniden başlayınca geri gelir", async () => {
    const e2 = await makeEnv({ LAZYPAD_SAVE_MS: "20" });
    const hub = await startHub(e2);
    await postHook(e2, { hook_event_name: "UserPromptSubmit", session_id: "s", project_dir: "/k/keep", prompt: "unutma" });
    await postHook(e2, { hook_event_name: "Stop", session_id: "s", project_dir: "/k/keep", last_assistant_message: "Kaydedildi, sonuç burada." });
    const s = await client(e2, "/session");
    s.json({ type: "hello", cwd: "/k/keep" });
    s.json({ type: "show", kind: "image", title: "Ekran", data: { src: "data:image/png;base64,AAAA", caption: "c" } });
    await sleep(120);
    s.close();
    const file = JSON.parse(readFileSync(join(e2.home, ".lazypad", "history.json"), "utf8"));
    assert.equal(file.events["/k/keep"].find((ev) => ev.kind === "image").data.src, null, "görsel diske yazılmamalı");
    hub.kill("SIGTERM");
    await hub.done;
    await startHub(e2);
    const b = await client(e2, "/board");
    const { tabs, events } = await b.seen((m) => m.type === "backlog", "backlog");
    assert.ok(tabs.some((t) => t.key === "/k/keep" && t.state === "idle"));
    assert.ok(events.some((ev) => ev.type === "prompt" && ev.text === "unutma"));
    assert.ok(events.some((ev) => ev.type === "done" && ev.summary.includes("Kaydedildi")));
    b.close();
    await e2.cleanup();
  });
  test("Kapatılan sekmenin geçmişi diskten de silinir", async () => {
    const e2 = await makeEnv({ LAZYPAD_SAVE_MS: "20" });
    await startHub(e2);
    await postHook(e2, { hook_event_name: "Stop", session_id: "s", project_dir: "/k/gone", last_assistant_message: "Silinecek cevap burada." });
    const b = await client(e2, "/board");
    await sleep(80);
    b.json({ type: "close_tab", key: "/k/gone" });
    await b.seen((m) => m.type === "tab_closed", "kapandı");
    await sleep(80);
    const file = JSON.parse(readFileSync(join(e2.home, ".lazypad", "history.json"), "utf8"));
    assert.equal(file.events["/k/gone"], undefined);
    b.close();
    await e2.cleanup();
  });
});
