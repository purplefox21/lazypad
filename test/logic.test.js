import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CARD_RULES, MODE_CONTEXT, contextFor, describeTool, failureText, lastAssistantText, notificationText, parseAnswer, readTurnItems, summarize, trunc, userText, wantsBoardCard, wasInterrupted } from "../src/logic.js";

const mode = (prompt, explain = "balanced") => {
  const c = contextFor(prompt, explain);
  return c.startsWith(MODE_CONTEXT.text) ? "text" : c.startsWith(MODE_CONTEXT.visual) ? "visual" : c.startsWith(MODE_CONTEXT.balanced) ? "balanced" : "?";
};

describe("anlatım modu", () => {
  for (const p of ["akışı çiz", "AKIŞI ÇİZ", "bunu çizer misin", "bunu şemayla anlat", "şema olarak göster", "grafikle göster",
    "tabloyla karşılaştır", "tablo yap", "görselle anlat", "diyagramla göster", "draw it", "DRAW IT", "visualize this", "show me a diagram", "explain it as a chart"]) {
    test(`görsel ister: ${p}`, () => assert.equal(mode(p), "visual"));
  }
  for (const p of ["bunu yazıyla anlat", "detaylı anlat", "uzun uzun açıkla", "metin olarak anlat", "metin olarak", "write it out", "explain it in text"]) {
    test(`metin ister: ${p}`, () => assert.equal(mode(p, "visual"), "text"));
  }
  for (const p of ["drawer bileşenini düzelt", "withdraw endpoint'ini yaz", "demografik veriyi temizle", "çizgi kalınlığını azalt",
    "çizelgeyi güncelle", "şemaya kolon ekle", "tabloya kolon ekle", "grafik kartını kontrol et", "chart bileşenini düzelt", "grafikle ilgili hatayı düzelt",
    "metinle başlayan satırları filtrele", "test yazarak başla", "fonksiyona açıklama yaz", "search in text files", "metin olarak kaydet"]) {
    test(`modu değiştirmez: ${p}`, () => assert.equal(mode(p), "balanced"));
  }
  test("ayar geçerli olur, bilinmeyen ayar görsele düşer", () => {
    assert.equal(contextFor("selam", "text"), MODE_CONTEXT.text);
    assert.equal(contextFor("selam", "yok"), MODE_CONTEXT.visual);
  });
  test("istem başına eklenen bağlam kısadır", () => {
    for (const c of Object.values(MODE_CONTEXT)) assert.ok(c.length < 160, c);
  });
  test("hiçbir mod sohbeti kısaltmaz: tam cevap sohbette kalır", () => {
    for (const c of Object.values(MODE_CONTEXT)) {
      assert.match(c, /complete answer in chat/);
      assert.doesNotMatch(c, /at most|\blines\b/);
    }
  });
  test("yapıştırılan uzun metnin ortası modu değiştirmez", () => {
    const filler = "x ".repeat(2000);
    assert.equal(mode(`${filler} akışı çiz ${filler}`), "balanced");
    assert.equal(mode(`${filler} akışı çiz`), "visual");
  });
});

describe("bildirimler", () => {
  test("izin isteği aracın adıyla söylenir", () => {
    assert.equal(notificationText({ notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }), "Bash için iznini bekliyor");
    assert.equal(notificationText({ notification_type: "permission_prompt", message: "Claude needs your permission" }), "İznini bekliyor");
  });
  test("boşta beklemek ve bilgi amaçlı bildirimler uyarı değildir", () => {
    for (const t of ["idle_prompt", "auth_success", "agent_completed", "elicitation_complete", "plugin_notification"]) {
      assert.equal(notificationText({ notification_type: t, message: "x" }), null, t);
    }
    assert.equal(notificationText({ message: "Claude is waiting for your input" }), null);
  });
  test("cevap isteyenler uyarıdır", () => {
    assert.equal(notificationText({ notification_type: "elicitation_dialog", message: "x" }), "Senden cevap bekliyor");
  });
  test("tür bilgisi yoksa metne bakılır", () => {
    assert.equal(notificationText({ message: "Claude needs your permission to use Edit" }), "Edit için iznini bekliyor");
  });
  test("hata metinleri", () => {
    assert.match(failureText("rate_limit"), /istek sınırı/);
    assert.match(failureText("yeni_bir_hata"), /bir hata oldu/);
  });
});

describe("özet", () => {
  test("başlık ve kod atlanır, ilk paragraf alınır", () => {
    assert.equal(summarize("# Başlık\n\n```js\nkod()\n```\n\nToken yenileme düzeltildi ve test eklendi."), "Token yenileme düzeltildi ve test eklendi.");
  });
  test("dosya adındaki nokta cümleyi bölmez", () => {
    assert.equal(summarize("hub.js dosyasını düzelttim."), "hub.js dosyasını düzelttim.");
  });
  test("boş metin", () => assert.equal(summarize(""), "Bitti."));
  test("uzun metin kısalır", () => assert.ok(summarize("a".repeat(1000)).length <= 240));
  test("trunc", () => assert.equal(trunc("abcdef", 4), "abc…"));
});

describe("cevabı bölümlere ayırma", () => {
  const TABLE = "| Ne | Nasıl |\n|---|---|\n| Kapat | `Cmd+Q` |\n| **Aç** | [open](http://x) |";
  const types = (blocks) => blocks.map((b) => b.t).join(" ");

  test("gerçek bir cevapta hiçbir bölüm kaybolmaz", () => {
    const answer = [
      "**Hayır, doğru kurarsak yavaş olmaz.**", "",
      "**Veriyi nasıl alırız:** Hazır dosyayı indiririz.", "",
      "**Ölçülen süreler:**", "", TABLE, "",
      "**Sorun yoğun yerlerde çıkıyor:** Taksim çok kalabalık.", "",
      "**Çözüm üç küçük değişiklik:**",
      "1. Eşleştirmeyi veritabanına alırız.",
      "2. Yakınlık filtresini zorunlu yaparız.",
      "3. Sonuç sayısına sınır koyarız.", "",
      "Bu henüz bir hedef.", "",
      "İlk adım olarak ölçeyim mi?",
    ].join("\n");
    const { blocks, question } = parseAnswer(answer);
    assert.equal(types(blocks), "p h p h table h p h ol p");
    assert.deepEqual(blocks.filter((b) => b.t === "h").map((b) => b.text),
      ["Veriyi nasıl alırız", "Ölçülen süreler", "Sorun yoğun yerlerde çıkıyor", "Çözüm üç küçük değişiklik"]);
    assert.equal(blocks.find((b) => b.t === "ol").items.length, 3);
    assert.equal(blocks[0].text, "**Hayır, doğru kurarsak yavaş olmaz.**");
    assert.equal(question, "İlk adım olarak ölçeyim mi?");
  });
  test("başlık biçimleri", () => {
    for (const head of ["## Komutlar", "Komutlar:", "**Komutlar:**", "**Komutlar**:", "**Komutlar**"]) {
      const { blocks } = parseAnswer(`${head}\n\nmetin burada`);
      assert.deepEqual(blocks[0], { t: "h", text: "Komutlar" }, head);
    }
  });
  test("kalın ya da uzun cümle başlık sayılmaz", () => {
    assert.equal(parseAnswer("**Bu bir cümledir.**").blocks[0].t, "p");
    assert.equal(parseAnswer("**Not** bunu unutma").blocks[0].t, "p");
    assert.equal(parseAnswer(`${"uzun ".repeat(30)}:`).blocks[0].t, "p");
  });
  test("tablo: hücreler temizlenir, sırası korunur", () => {
    const { blocks } = parseAnswer(`Önce bu.\n\n${TABLE}\n\nSonra bu.`);
    assert.equal(types(blocks), "p table p");
    assert.deepEqual(blocks[1].columns, ["Ne", "Nasıl"]);
    assert.deepEqual(blocks[1].rows, [["Kapat", "Cmd+Q"], ["Aç", "open"]]);
  });
  test("baş ve son çizgisi olmayan, hizalı tablo", () => {
    const [t] = parseAnswer("a | b\n:--- | ---:\n1 | 2").blocks;
    assert.deepEqual([t.columns, t.rows], [["a", "b"], [["1", "2"]]]);
  });
  test("kaçışlı dikey çizgi hücreyi bölmez", () => {
    assert.deepEqual(parseAnswer("| a |\n|---|\n| x \\| y |").blocks[0].rows, [["x | y"]]);
  });
  test("tabloya benzeyen metinler tablo olmaz", () => {
    for (const t of ["a | b\nnormal satır", "a | b\n---", "cmd | grep x"]) {
      assert.ok(!parseAnswer(t).blocks.some((b) => b.t === "table"), t);
    }
  });
  test("kod bloğu olduğu gibi kalır", () => {
    const { blocks } = parseAnswer("Bak:\n\n```js\n| a |\n|---|\n# yorum\n1. x\n```\n\nBitti.");
    assert.deepEqual(blocks[1], { t: "code", text: "| a |\n|---|\n# yorum\n1. x" });
    assert.equal(types(blocks), "h code p");
  });
  test("listeler: boşlukla ayrılmış maddeler, devam satırları, alt maddeler, başlangıç numarası", () => {
    assert.deepEqual(parseAnswer("1. a\n\n2. b").blocks, [{ t: "ol", start: 1, items: ["a", "b"] }]);
    assert.deepEqual(parseAnswer("- a\n  devamı\n- b").blocks, [{ t: "ul", items: ["a devamı", "b"] }]);
    assert.deepEqual(parseAnswer("1. a\n   - alt\n2. b").blocks, [{ t: "ol", start: 1, items: ["a · alt", "b"] }]);
    assert.equal(parseAnswer("Metin.\n\n3. c").blocks[1].start, 3);
    assert.equal(types(parseAnswer("- a\n\nParagraf.").blocks), "ul p");
  });
  test("kalın yazı liste maddesi sanılmaz, ayırıcı çizgi atlanır", () => {
    assert.equal(types(parseAnswer("**Kalın** metin\n\n---\n\nSonra").blocks), "p p");
  });
  test("satır kırılmış paragraf birleşir", () => {
    assert.deepEqual(parseAnswer("bir\niki").blocks, [{ t: "p", text: "bir iki" }]);
  });

  test("son paragraf soruysa ayrılır, önceki cümleler metinde kalır", () => {
    const { blocks, question } = parseAnswer("Ölçüm bitti. hub.js dosyasına baktım. Devam edeyim mi?");
    assert.equal(question, "Devam edeyim mi?");
    assert.equal(blocks[0].text, "Ölçüm bitti. hub.js dosyasına baktım.");
  });
  test("kalın soru temiz okunur; yalnızca sorudan oluşan cevap", () => {
    const { blocks, question } = parseAnswer("**Hangisini `seçelim`?**");
    assert.equal(question, "Hangisini seçelim?");
    assert.equal(blocks.length, 0);
  });
  test("seçenek listesinden hemen önceki soru da yakalanır, seçenekler kalır", () => {
    const { blocks, question } = parseAnswer("Hangisini seçelim?\n\n1. A\n2. B");
    assert.equal(question, "Hangisini seçelim?");
    assert.equal(types(blocks), "ol");
  });
  test("soruyla bitmeyen cevapta soru yoktur", () => {
    for (const t of ["Neden yavaş? Çünkü indeks yok.", "Bitti.", "Soru mu?\n\nHayır, bitti.", "```\nx?\n```", ""]) {
      assert.equal(parseAnswer(t).question, null, t);
    }
  });
  test("boş girdi", () => assert.deepEqual(parseAnswer(undefined), { blocks: [], question: null, quick: [] }));
  test("tek tıklık cevaplar: evet/hayır soruları ve seçenekler", () => {
    for (const q of ["Ölçeyim mi?", "Devam edelim mi?", "Bunu ister misin?", "BAŞLAYAYIM MI?", "Should I continue?", "Do you want this?"]) {
      assert.deepEqual(parseAnswer(q).quick, ["Evet", "Hayır"], q);
    }
    for (const q of ["Hangisi daha iyi?", "Ne zaman başlayalım?", "Which one?", "Kimi?"]) {
      assert.deepEqual(parseAnswer(q).quick, [], q);
    }
    assert.deepEqual(parseAnswer("Hangisi?\n\n- **A** yolu\n- `B` yolu").quick, ["A yolu", "B yolu"]);
  });
});

describe("kullanıcının mesajı", () => {
  test("editörün eklediği bloklar çıkar", () => {
    assert.equal(userText("<browser_instruction># Uzun\nmetin</browser_instruction>selam dostum"), "selam dostum");
    assert.equal(userText("<ide_selection>kod</ide_selection>\nbunu düzelt\n<system-reminder>x</system-reminder>"), "bunu düzelt");
  });
  test("sistem bildirimi kullanıcı mesajı değildir", () => {
    assert.equal(userText("<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>"), "");
  });
  test("normal metin ve boş girdi", () => {
    assert.equal(userText("a < b ve c > d"), "a < b ve c > d");
    assert.equal(userText(undefined), "");
  });
  test("eklenen blok anlatım modunu tetiklemez", () => {
    assert.equal(contextFor(userText("<browser_instruction>draw it, çiz</browser_instruction>selam"), "balanced"), MODE_CONTEXT.balanced);
  });
});

describe("tahta özeti isteği", () => {
  test("kısa cevap özet istemez", () => {
    for (const t of ["Tamam, bitti.", "Dosyayı düzelttim. Testler geçti.", "1. Bir\n2. İki", "", undefined]) assert.equal(wantsBoardCard(t), false, String(t));
  });
  test("uzun ya da yapılı cevap özet ister", () => {
    assert.equal(wantsBoardCard("a ".repeat(400)), true);
    assert.equal(wantsBoardCard("| a |\n|---|\n| 1 |"), true);
    assert.equal(wantsBoardCard("1. Bir\n2. İki\n3. Üç"), true);
    assert.equal(wantsBoardCard("## Bir\n\nx\n\n## İki\n\ny"), true);
  });
  test("kurallar bilgi kaybını ve az yazıyı söyler", () => {
    assert.match(CARD_RULES, /Lose no important information/);
    assert.match(CARD_RULES, /`page`/);
    assert.match(CARD_RULES, /without writing anything in chat/);
  });
});

describe("izin kartı anlatımı", () => {
  test("komut, dosya ve bilinmeyen araç", () => {
    assert.deepEqual(describeTool("Bash", { command: "ls -la", description: "Listele" }), { title: "Listele", detail: "ls -la" });
    assert.equal(describeTool("Bash", { command: "ls" }).title, "Komut çalıştırmak istiyor");
    assert.match(describeTool("Write", { file_path: "/a.js", content: "x" }).title, /\/a\.js/);
    assert.match(describeTool("Edit", { file_path: "/a.js", old_string: "x", new_string: "y" }).detail, /- x\n\+ y/);
    assert.equal(describeTool("WebFetch", { url: "https://a.b" }).detail, "https://a.b");
    assert.match(describeTool("mcp__x__y", { a: 1 }).title, /mcp__x__y/);
    assert.match(describeTool("mcp__x__y", { a: 1 }).detail, /"a": 1/);
  });
  test("uzun içerik kesilir", () => {
    assert.ok(describeTool("Write", { file_path: "/a", content: "x".repeat(9000) }).detail.length <= 2000);
  });
});

describe("transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "lazypad-logic-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const file = (...entries) => {
    const p = join(dir, `t${n++}.jsonl`);
    writeFileSync(p, entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
    return p;
  };
  const user = (content, extra = {}) => ({ type: "user", message: { content }, ...extra });
  const assistant = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } };
  const interrupted = user([{ type: "text", text: "[Request interrupted by user]" }]);

  test("tur içeriği sırayla okunur, yarım satır sonraya kalır", () => {
    const body = JSON.stringify(assistant("bir")) + "\n" + JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } }) + "\n";
    const p = join(dir, "turn.jsonl");
    writeFileSync(p, body + '{"type":"assis');
    const a = readTurnItems(p, 0);
    assert.deepEqual(a.items, [{ t: "text", text: "bir" }, { t: "tool", name: "Bash" }]);
    assert.equal(a.pos, Buffer.byteLength(body));
    writeFileSync(p, body + JSON.stringify(assistant("iki")) + "\n");
    assert.deepEqual(readTurnItems(p, a.pos).items, [{ t: "text", text: "iki" }]);
    assert.deepEqual(readTurnItems(join(dir, "yok.jsonl"), 5), { pos: 5, items: [] });
    assert.deepEqual(readTurnItems(undefined, 3), { pos: 3, items: [] });
  });
  test("yan zincir ara mesaj sayılmaz", () => {
    const p = file({ ...assistant("yan"), isSidechain: true }, assistant("ana"));
    assert.deepEqual(readTurnItems(p, 0).items, [{ t: "text", text: "ana" }]);
  });
  test("son asistan metni", () => assert.equal(lastAssistantText(file(user("x"), assistant("cevap"), toolResult)), "cevap"));
  test("önceki turun cevabını döndürmez (metin dizisi)", () => {
    assert.equal(lastAssistantText(file(assistant("eski"), user([{ type: "text", text: "yeni" }]))), "");
  });
  test("önceki turun cevabını döndürmez (düz metin)", () => assert.equal(lastAssistantText(file(assistant("eski"), user("yeni"))), ""));
  test("meta iletiler tur başı sayılmaz", () => {
    assert.equal(lastAssistantText(file(assistant("cevap"), user([{ type: "text", text: "<reminder>" }], { isMeta: true }))), "cevap");
  });
  test("yan zincir ve bozuk satır atlanır", () => {
    assert.equal(lastAssistantText(file(assistant("cevap"), "{bozuk", { ...assistant("yan"), isSidechain: true })), "cevap");
  });
  test("olmayan dosya", () => {
    assert.equal(lastAssistantText(join(dir, "yok.jsonl")), "");
    assert.equal(lastAssistantText(undefined), "");
    assert.equal(wasInterrupted(join(dir, "yok.jsonl")), false);
  });

  test("kesinti görülür, ardından gelen meta satırlar engel olmaz", () => {
    assert.equal(wasInterrupted(file(user("x"), interrupted)), true);
    assert.equal(wasInterrupted(file(user("x"), interrupted, { type: "queue-operation" }, { type: "last-prompt" })), true);
    assert.equal(wasInterrupted(file(user("x"), user([{ type: "text", text: "[Request interrupted by user for tool use]" }]))), true);
  });
  test("normal akış kesinti değildir", () => {
    assert.equal(wasInterrupted(file(user("x"), assistant("y"))), false);
    assert.equal(wasInterrupted(file(user("x"), assistant("y"), toolResult)), false);
    assert.equal(wasInterrupted(file(interrupted, user("devam et"))), false);
  });
  test("istemden önceki kesinti sayılmaz", () => {
    const p = file(user("x"), interrupted);
    const before = JSON.stringify(user("x")).length + 1 + JSON.stringify(interrupted).length + 1;
    assert.equal(wasInterrupted(p, 0), true);
    assert.equal(wasInterrupted(p, before), false);
  });
});
