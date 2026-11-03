// Saf yardımcılar: sunucu ya da süreç başlatmaz, bu yüzden tek başına test edilebilir.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// ---------------------------------------------------------------- anlatım modu
// Biçim rehberi MCP talimatlarında duruyor; burada her mesaja sadece mod eklenir.
export const MODE_CONTEXT = {
  visual: "[Lazypad] Explanation mode: VISUAL. Write your complete answer in chat as usual, and also put anything with structure on the board.",
  balanced: "[Lazypad] Explanation mode: BALANCED. Write your complete answer in chat as usual; use the board for flows and comparisons.",
  text: "[Lazypad] Explanation mode: TEXT. Write your complete answer in chat as usual; board visuals are optional.",
};

const START = "(?<![\\p{L}\\p{N}_])";
const END = "(?![\\p{L}\\p{N}_])";
const NOT_ABOUT = "(?!\\s+ilgili)"; // "grafikle ilgili hata" görsel isteği değil
const anyOf = (list) => new RegExp(`${START}(?:${list.join("|")})`, "u");

const WANTS_TEXT = anyOf([
  `yazıyla${END}${NOT_ABOUT}`,
  "metin(?:le|\\s+olarak)\\s+(?:anlat|açıkla|yaz|ver)",
  "metin\\s+olarak\\s*[.!?]*$",
  "yazarak\\s+(?:anlat|açıkla)",
  "detaylı\\s+(?:yaz|anlat|açıkla)",
  "uzun\\s+uzun",
  `write\\s+it\\s+out${END}`,
  `(?:explain|describe|answer)[^.!?\\n]*\\sin\\s+(?:plain\\s+)?text${END}(?!\\s+files?)`,
]);
const WANTS_VISUAL = anyOf([
  "çiz(?!gi|elge|ik|im)\\p{L}*", // çiz, çizer misin, çizerek; çizgi ve çizelge değil
  `(?:şema|diyagram|görsel|tablo|grafik|çizim)(?:y?la|y?le)${END}${NOT_ABOUT}`,
  "(?:şema(?:sını)?|diyagram(?:ını)?|görsel(?:ini)?|tablo(?:sunu)?|grafi(?:k|ğini))\\s+(?:olarak|halinde|yap|göster|çıkar|hazırla)",
  `visuali[sz]e${END}`,
  `draw\\s+(?:it|this|that|me|a|an|the)${END}`,
  `(?:as|with|in)\\s+an?\\s+(?:diagram|chart|graph|table)${END}`,
  `show\\s+(?:me\\s+)?(?:it\\s+|this\\s+)?(?:as\\s+)?an?\\s+(?:diagram|chart|graph|table)${END}`,
]);

export function contextFor(prompt = "", explain = "visual") {
  // Yapıştırılan uzun metnin ortası niyet taşımaz
  const p = prompt.length > 2000 ? prompt.slice(0, 1000) + "\n" + prompt.slice(-1000) : prompt;
  const forms = [p.toLocaleLowerCase("tr"), p.toLowerCase()]; // "ÇİZ" ve "DRAW IT" ikisi de doğru küçülsün
  const wants = (re) => forms.some((f) => re.test(f));
  if (wants(WANTS_TEXT)) return MODE_CONTEXT.text + " (The message seems to ask for text this time; use your judgment.)";
  if (wants(WANTS_VISUAL)) return MODE_CONTEXT.visual + " (The message seems to ask for a visual this time; use your judgment.)";
  return MODE_CONTEXT[explain] || MODE_CONTEXT.visual;
}

// ---------------------------------------------------------------- bildirimler
const ATTENTION_TYPES = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

/** Kullanıcıyı gerçekten bekleyen bildirimin Türkçe metni; gerisi (idle_prompt vb.) için null. */
export function notificationText({ notification_type: type, message: msg = "" } = {}) {
  if (type ? !ATTENTION_TYPES.has(type) : /waiting for your input|idle/i.test(msg)) return null;
  const perm = msg.match(/permission to use (.+)$/i);
  if (perm) return `${perm[1]} için iznini bekliyor`;
  if (type === "permission_prompt" || /permission/i.test(msg)) return "İznini bekliyor";
  if (type) return "Senden cevap bekliyor";
  return msg || "Seni bekliyor";
}

const FAILURES = {
  rate_limit: "istek sınırına takıldı",
  overloaded: "servis çok yoğun",
  authentication_failed: "oturum doğrulanamadı",
  billing_error: "faturalandırma sorunu var",
  server_error: "sunucu hatası oldu",
  max_output_tokens: "cevap çok uzadığı için kesildi",
};
export const failureText = (error) => `Claude durdu: ${FAILURES[error] || "bir hata oldu"}.`;

// ---------------------------------------------------------------- özet
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

// ---------------------------------------------------------------- cevabı bölümlere ayırma
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)(?:(\d+)[.)]|[-*•])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const LONGEST_TITLE = 90;

const cellsOf = (line) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/)
  .map((c) => c.replace(/\\\|/g, "|").replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim());

/** "**Başlık:** metin", "**Başlık**" ve "Başlık:" paragrafları tahtada bölüm başlığı olur. */
function paragraphBlocks(p) {
  const lead = p.match(/^\*\*([^*]+?):\*\*\s+([\s\S]+)$/) || p.match(/^\*\*([^*]+?)\*\*:\s+([\s\S]+)$/);
  if (lead && lead[1].length <= LONGEST_TITLE) return [{ t: "h", text: lead[1] }, { t: "p", text: lead[2] }];
  const bold = p.match(/^\*\*([^*]+?)\*\*:?$/);
  if (bold && !/[.!?]$/.test(bold[1])) return [{ t: "h", text: bold[1].replace(/:$/, "") }];
  if (p.endsWith(":") && p.length <= LONGEST_TITLE) return [{ t: "h", text: p.slice(0, -1) }];
  return [{ t: "p", text: p }];
}

const plainText = (s) => s.replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
const YES_NO_TR = /(?<!\p{L})m[ıiuü](?:y[ıiuü]m|s[ıiuü]n|y[ıiuü]z|s[ıiuü]n[ıiuü]z)?\s*\?$/u;
const YES_NO_EN = /^(?:should|shall|do|does|did|can|could|would|will|is|are|may)\b/i;

/** Claude soruyla bitirdiyse sırayı kullanıcıya verir: soru metinden ayrılır, tahtada öne çıkar. */
function takeQuestion(blocks) {
  const isList = (b) => b?.t === "ol" || b?.t === "ul";
  const last = blocks.at(-1);
  const i = last?.t === "p" ? blocks.length - 1 : isList(last) && blocks.at(-2)?.t === "p" ? blocks.length - 2 : -1;
  if (i < 0 || !/\?(\*\*)?\s*$/.test(blocks[i].text)) return { question: null, quick: [] };
  const sentences = blocks[i].text.match(/[\s\S]*?[.!?](?=\s|$)|[\s\S]+$/g);
  const question = plainText(sentences.pop());
  const rest = sentences.join("").trim();
  const options = i < blocks.length - 1 ? blocks.at(-1).items.map(plainText) : [];
  if (rest) blocks[i].text = rest;
  else blocks.splice(i, 1);
  // Tek tıkla cevap: soru seçenek saydıysa onlar, evet/hayır sorusuysa onlar
  const yesNo = YES_NO_TR.test(question.toLocaleLowerCase("tr")) || YES_NO_EN.test(question);
  return { question, quick: options.length ? options : yesNo ? ["Evet", "Hayır"] : [] };
}

/** Cevabı sırasını bozmadan bloklara, sondaki soruyu da ayrı alana ayırır. */
export function parseAnswer(full) {
  const blocks = parseBlocks(full);
  return { blocks, ...takeQuestion(blocks) };
}

/** Metni başlık, paragraf, liste, tablo ve kod bloklarına ayırır. Tahta bunları çizer. */
export function parseBlocks(full) {
  const lines = String(full || "").split("\n");
  const blocks = [];
  let para = [], list = null;
  const endPara = () => { if (para.length) blocks.push(...paragraphBlocks(para.join(" "))); para = []; };
  const endList = () => { if (list) blocks.push(list); list = null; };
  const endAll = () => { endPara(); endList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s*>\s?/, ""), next = lines[i + 1] ?? "";
    if (FENCE.test(line)) {
      endAll();
      const code = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ t: "code", text: code.join("\n") });
    } else if (line.includes("|") && next.includes("|") && SEPARATOR.test(next)) {
      endAll();
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(cellsOf(lines[i]));
      i--;
      blocks.push({ t: "table", columns: cellsOf(line), rows });
    } else if (!line.trim()) {
      endPara(); // boşlukla ayrılmış maddeler aynı listede kalır
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      endAll();
    } else if (/^\s{0,3}#{1,6}\s+/.test(line)) {
      endAll();
      blocks.push({ t: "h", text: line.replace(/^\s*#+\s+/, "").replace(/\s+#+\s*$/, "").replace(/:$/, "") });
    } else {
      const item = line.match(LIST_ITEM);
      if (item) {
        endPara();
        const [, indent, num, text] = item;
        const t = num ? "ol" : "ul";
        if (list && indent.length >= 2) { // alt madde: numaralar bozulmasın diye üst maddeye eklenir
          list.items[list.items.length - 1] += ` · ${text}`;
        } else {
          if (list?.t !== t) { endList(); list = { t, items: [], ...(num ? { start: Number(num) } : {}) }; }
          list.items.push(text);
        }
      } else if (list && /^\s{2,}\S/.test(line)) { // maddenin devam satırı
        list.items[list.items.length - 1] += ` ${line.trim()}`;
      } else {
        endList();
        para.push(line.trim());
      }
    }
  }
  endAll();
  return blocks;
}

// ---------------------------------------------------------------- kullanıcının mesajı
const ADDED_BLOCKS = /<(browser_instruction|system-reminder|ide_selection|ide_opened_file|ide_diagnostics)\b[^>]*>[\s\S]*?<\/\1>/g;

/** Kullanıcının kendi yazdığı metin: editörün eklediği bloklar çıkar, Claude Code'un sistem bildirimi boş döner. */
export function userText(prompt = "") {
  const text = String(prompt);
  if (/^\s*<task-notification>/.test(text)) return "";
  return text.replace(ADDED_BLOCKS, "").trim();
}

// ---------------------------------------------------------------- tahta özeti
/** Uzun ya da yapılı cevap tahtada ayrıca görsel özet ister; kısa cevaba özet cümlesi yeter. */
export function wantsBoardCard(full) {
  const text = String(full || "");
  if (text.length >= 600) return true;
  const blocks = parseBlocks(text);
  return blocks.some((b) => b.t === "table" || ((b.t === "ol" || b.t === "ul") && b.items.length >= 3)) ||
    blocks.filter((b) => b.t === "h").length >= 2;
}

/** Claude uzun cevabını bitirince verilen görev: cevabın tahta özetini bu kurallarla yazar. */
export const CARD_RULES = `Your final answer stays in chat as it is. Now write its summary for the board with the lazypad \`page\` tool. Don't rewrite or shorten anything in chat.
The user reads very little but must understand everything from this page, without opening the chat. Rules:
- Lose no important information: the result, decisions, every number that matters, risks, next steps and every option must be on it. Drop only explanations, repetition and filler.
- Far less text than the chat answer, at most a quarter of its words: no paragraphs, only short labels and short lines.
- Visual first. Pick what fits the content: a one-line result (.lead), a flow diagram (<pre class="mermaid">), numbers as .bars or .stat tiles, side-by-side comparison (.cols), a table, images.
- If the answer ends with a question, don't repeat it: the board already shows it with buttons.
- The user's language with its correct letters, no emojis. The page title states the takeaway, not the topic.
If a page you already drew this turn covers all of this, don't draw another.
After that, end your turn immediately without writing anything in chat.`;

// ---------------------------------------------------------------- izin kartları
/** Claude'un ne yapmak istediğinin kısa anlatımı: `title` tek satır, `detail` ayrıntı. */
export function describeTool(name, input = {}) {
  const cut = (s, n = 2000) => trunc(s, n);
  switch (name) {
    case "Bash": return { title: input.description || "Komut çalıştırmak istiyor", detail: cut(input.command) };
    case "Write": return { title: `Dosya yazmak istiyor: ${input.file_path}`, detail: cut(input.content) };
    case "Edit": case "MultiEdit": return { title: `Dosya değiştirmek istiyor: ${input.file_path}`, detail: cut(`- ${input.old_string ?? ""}\n+ ${input.new_string ?? ""}`) };
    case "NotebookEdit": return { title: `Not defterini değiştirmek istiyor: ${input.notebook_path}`, detail: cut(input.new_source) };
    case "WebFetch": return { title: "Web sayfası açmak istiyor", detail: cut(input.url) };
    case "WebSearch": return { title: "Web'de aramak istiyor", detail: cut(input.query) };
    default: return { title: `${name} aracını kullanmak istiyor`, detail: cut(JSON.stringify(input, null, 2)) };
  }
}

// ---------------------------------------------------------------- transcript
/** Transcript'in sonundaki girdiler, en yenisi önce. `from`: bu bayttan öncesine bakma. */
function tailEntries(path, max, from = 0) {
  if (!path) return [];
  let fd;
  try {
    const size = statSync(path).size;
    const start = Math.max(from, size - max);
    if (start >= size) return [];
    const buf = Buffer.alloc(size - start);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, start);
    const out = [];
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      try { const o = JSON.parse(line); if (o && typeof o === "object" && !o.isSidechain) out.push(o); } catch {}
    }
    return out;
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";

/**
 * Transcript'e `pos` baytından sonra eklenen asistan metinleri ve araç çağrıları, sırayla.
 * Yarım yazılmış son satır bir sonraki okumaya kalır.
 */
export function readTurnItems(path, pos = 0) {
  if (!path) return { pos, items: [] };
  let fd;
  try {
    const size = statSync(path).size;
    if (size <= pos) return { pos: Math.min(pos, size), items: [] };
    const buf = Buffer.alloc(size - pos);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, pos);
    const end = buf.lastIndexOf(10);
    if (end < 0) return { pos, items: [] };
    const items = [];
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o?.type !== "assistant" || o.isSidechain) continue;
      for (const c of o.message?.content || []) {
        if (c.type === "text" && c.text?.trim()) items.push({ t: "text", text: c.text });
        else if (c.type === "tool_use") items.push({ t: "tool", name: c.name });
      }
    }
    return { pos: pos + end + 1, items };
  } catch { return { pos, items: [] }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Bu turdaki son asistan metni. */
export function lastAssistantText(path) {
  for (const o of tailEntries(path, 1024 * 1024)) {
    if (o.type === "user" && !o.isMeta && textOf(o.message?.content)) return ""; // tur başı
    if (o.type === "assistant") {
      const text = textOf(o.message?.content).trim();
      if (text) return text;
    }
  }
  return "";
}

/** Tur Esc ile kesildi mi? Claude Code bu durumda Stop hook'unu çalıştırmaz. */
export function wasInterrupted(path, from = 0) {
  for (const o of tailEntries(path, 64 * 1024, from)) {
    if (o.type === "assistant") return false;
    if (o.type === "user" && !o.isMeta) {
      const text = textOf(o.message?.content);
      if (text) return text.startsWith("[Request interrupted by user");
    }
  }
  return false;
}
