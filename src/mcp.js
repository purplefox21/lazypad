// MCP sunucusu (her Claude oturumu için bir tane). Araçları merkeze iletir.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BASE, authHeaders, ensureHub, probeHub, sleep } from "./shared.js";

const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ASK_TIMEOUT_MS = Number(process.env.LAZYPAD_ASK_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_OUTBOX = 200;

// ---------------------------------------------------------------- merkez bağlantısı
let ws = null;
let stopped = false; // `lazypad stop` sonrası gerek olana kadar yeniden başlatma
let retryMs = 1000;
const outbox = [];
const pendingAsks = new Map(); // id -> { settle, question, options }

async function connect() {
  await ensureHub();
  const sock = new WebSocket(BASE.replace("http", "ws") + "/session", { headers: authHeaders() });
  ws = sock;
  sock.on("open", () => {
    retryMs = 1000;
    sock.send(JSON.stringify({ type: "hello", cwd: CWD }));
    // Merkez yeniden başladıysa bekleyen kararlar yeniden kart olur, değilse sahipleri güncellenir
    for (const id of pendingAsks.keys()) sendAsk(id);
    while (outbox.length) sock.send(outbox.shift());
  });
  sock.on("message", (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === "answer") pendingAsks.get(m.id)?.settle(m);
    else if (m.type === "shutdown") stopped = pendingAsks.size === 0;
  });
  sock.on("close", async () => {
    if (stopped) return;
    await sleep(retryMs);
    retryMs = Math.min(retryMs * 2, 15_000);
    connect();
  });
  sock.on("error", () => {}); // close zaten tetiklenir
}

function wake() {
  if (!stopped) return;
  stopped = false;
  connect();
}

// `stop` sonrası merkezi kendimiz başlatmayız, ama başkası açtıysa geri bağlanırız
setInterval(async () => { if (stopped && await probeHub() === "ok") wake(); }, 5000).unref();

function send(msg) {
  const data = JSON.stringify(msg);
  if (ws?.readyState === 1) return ws.send(data);
  outbox.push(data);
  if (outbox.length > MAX_OUTBOX) outbox.shift();
  wake();
}

function sendAsk(id) {
  const a = pendingAsks.get(id);
  if (!a) return;
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "ask", id, question: a.question, options: a.options, multi: a.multi }));
  else wake(); // bağlantı gelince açılışta gönderilir
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

// ---------------------------------------------------------------- araçlar
const INSTRUCTIONS = `Lazypad is the user's voice + visual board. The board is a second view of your work, never a replacement: always write your complete answer in chat as you normally would, so nothing exists only on the board.
The user reads very little on the board but must understand everything from it. Use it freely like an artifact canvas, in whatever form fits best: \`page\` for free-form visual pages (photos, side-by-side comparison, tiles, bars, diagrams), \`draw\` and \`show\` for single visuals.
Hooks already show prompts, changed files, short progress notes, permission prompts, AskUserQuestion and plans on the board, and the user can answer them there. After a long final answer you are asked to write its visual summary with \`page\`, so nothing important is lost. Each prompt also carries a [Lazypad] explanation mode (VISUAL / BALANCED / TEXT) that says how much to put on the board; follow it.
The user can also type to you from the board. Such a message reaches you as a [Lazypad] note: treat it as a user message.
Choose the form by the content:
- flow, architecture, call order, cause→effect, states → \`draw\` (Mermaid: flowchart, sequenceDiagram, mindmap, stateDiagram), 3-10 nodes
- options, comparisons, before/after → \`show\` kind "table" or "compare"
- numbers, sizes, timings, trends → \`show\` kind "chart" (bar for categories, line for change over time)
- several takeaways → \`show\` kind "points"
One visual per idea, small and labeled in the user's language with its correct letters (ş, ı, ğ), never ASCII substitutes.
A card title states the takeaway, not the topic ("Taksim has as many places as all of Ankara", not "Place counts"), without internal jargon the user hasn't seen.
Diagrams must stay readable on a narrow board: use top-down (graph TD) when a row would have more than 4 nodes.
Other tools:
- \`say\`: tell something important in max 2 short sentences, in the user's language. level "warn" only for things the user must know.
- \`plan\`: at the start of a multi-step task, list all the steps; then \`step\` marks each one doing → done/fail with the same text.
- \`progress\`: for long work with a known size (files, tests, records), update a live progress bar.
- \`show\` kinds "code", "diff", "image" (a screenshot or generated image by file path), "files" (clickable files that open in the editor).
- To ask a decision, prefer your built-in AskUserQuestion tool when you have it: it appears in chat and on the board, and either can answer it. Use \`ask\` when you don't have it. Only ask when it's hard to reverse or truly the user's call; decide routine things yourself. Recommended option first. No answer is never approval.
- Never use emojis in board content.
- Start the final chat reply with the outcome: its first 1-2 sentences are read aloud as the summary.
- If you need the user's decision to continue, end the reply with one clear question: the board highlights it and marks the tab as waiting.`;

const mcp = new McpServer({ name: "lazypad", version: "0.3.0" }, { instructions: INSTRUCTIONS });

mcp.registerTool(
  "say",
  {
    description: "Speak a SHORT message (max 2 sentences) aloud on the Lazypad board. level 'warn' only for things the user must know. User's language, no emojis.",
    inputSchema: {
      text: z.string().max(400).describe("Short spoken message, max 2 sentences"),
      level: z.enum(["ok", "warn"]).default("ok"),
      notify: z.boolean().optional().describe("Also show a desktop notification, for things the user should see even when away"),
    },
  },
  async ({ text, level, notify }) => { send({ type: "say", text, level, notify }); return ok("söylendi"); }
);

mcp.registerTool(
  "draw",
  {
    description: "Draw a small Mermaid diagram on the Lazypad board alongside your chat answer (flows, architecture, cause→effect). 3-10 nodes, labels in the user's language, no emojis.",
    inputSchema: {
      title: z.string().max(80),
      mermaid: z.string().max(4000).describe("Mermaid source, e.g. 'graph LR; A[Giriş]-->B[Token]'"),
    },
  },
  async ({ title, mermaid }) => { send({ type: "draw", title, mermaid }); return ok("çizildi"); }
);

const Show = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("table"),
    columns: z.array(z.string().max(60)).min(1).max(8),
    rows: z.array(z.array(z.union([z.string().max(200), z.number()])).max(8)).max(30),
  }),
  z.object({
    kind: z.literal("chart"),
    chart: z.enum(["bar", "line"]).describe("bar: compare categories; line: change over time"),
    labels: z.array(z.string().max(40)).min(1).max(24).describe("x axis labels"),
    series: z.array(z.object({
      name: z.string().max(40),
      values: z.array(z.number()).describe("one value per label"),
    })).min(1).max(4),
    unit: z.string().max(12).optional().describe("e.g. 'ms', '%', 'MB'"),
  }),
  z.object({
    kind: z.literal("compare"),
    left: z.object({ label: z.string().max(40), items: z.array(z.string().max(160)).max(10) }),
    right: z.object({ label: z.string().max(40), items: z.array(z.string().max(160)).max(10) }),
  }),
  z.object({
    kind: z.literal("points"),
    items: z.array(z.object({ title: z.string().max(60), text: z.string().max(200).optional() })).min(1).max(8),
  }),
  z.object({
    kind: z.literal("code"),
    code: z.string().max(20000),
    language: z.string().max(30).optional(),
    path: z.string().max(400).optional().describe("File the code comes from, if any"),
  }),
  z.object({
    kind: z.literal("diff"),
    diff: z.string().max(20000).describe("Unified diff text: lines starting with + and -"),
    path: z.string().max(400).optional(),
  }),
  z.object({
    kind: z.literal("image"),
    path: z.string().max(1000).describe("Image file path: png, jpg, gif or webp, up to 4 MB"),
    caption: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal("files"),
    items: z.array(z.object({
      path: z.string().max(1000),
      line: z.number().int().positive().optional(),
      note: z.string().max(200).optional().describe("Why this file matters"),
    })).min(1).max(30),
  }),
]);

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Görseli tahtaya gömülecek biçime çevirir; sorun varsa nedenini söyler. */
function loadImage(raw) {
  const path = raw.replace(/^file:\/\//, "");
  const abs = isAbsolute(path) ? path : resolvePath(CWD, path);
  const type = IMAGE_TYPES[extname(abs).toLowerCase()];
  if (!type) return { error: "Hata: yalnızca png, jpg, gif ya da webp gösterilebilir." };
  try {
    if (statSync(abs).size > MAX_IMAGE_BYTES) return { error: "Hata: görsel 4 MB'tan büyük." };
    return { src: `data:${type};base64,${readFileSync(abs).toString("base64")}` };
  } catch { return { error: `Hata: görsel okunamadı: ${abs}` }; }
}

mcp.registerTool(
  "show",
  {
    description: "Show structured content on the Lazypad board alongside your chat answer. " +
      "kind 'table' (columns + rows) for options/comparisons; 'chart' (bar|line, labels, 1-4 series, unit) for numbers; " +
      "'compare' (left/right lists, e.g. before/after or option A/B); 'points' (2-8 short takeaways); " +
      "'code' (a snippet); 'diff' (unified diff text); 'image' (screenshot or image by file path); 'files' (files the user can open in the editor). " +
      "User's language, short cells, no emojis.",
    inputSchema: {
      title: z.string().max(80),
      content: Show,
    },
  },
  async ({ title, content }) => {
    const { kind, ...data } = content;
    if (kind === "chart" && data.series.some((s) => s.values.length !== data.labels.length)) {
      return fail("Hata: her serideki değer sayısı etiket sayısına eşit olmalı. Düzeltip tekrar çağır.");
    }
    if (kind === "image") {
      const image = loadImage(data.path);
      if (image.error) return fail(image.error);
      data.src = image.src;
    }
    send({ type: "show", kind, title, data });
    return ok("gösterildi");
  }
);

const MAX_PAGE_CHARS = 6 * 1024 * 1024;

/** <img src="dosya yolu"> etiketlerini sayfaya gömer: tahta diskten dosya okuyamaz. */
function embedImages(html) {
  let error = null;
  const out = html.replace(/(<img\b[^>]*?\bsrc=)(["'])(.*?)\2/gi, (tag, before, quote, src) => {
    if (src.startsWith("data:")) return tag;
    const image = loadImage(src);
    if (image.error) { error = image.error; return tag; }
    return `${before}${quote}${image.src}${quote}`;
  });
  return { html: out, error: error ?? (out.length > MAX_PAGE_CHARS ? "Hata: sayfa çok büyük, görselleri küçült ya da azalt." : null) };
}

mcp.registerTool(
  "page",
  {
    description: "Draw a free-form visual page on the Lazypad board, like an artifact: write the HTML body yourself. Photos by file path (<img src=\"/path/a.png\">), side-by-side comparisons, tiles, bars, tables, diagrams. " +
      "Ready classes: .lead (one-line result), .cols (side by side), .box (panel), .stat (<div class=\"stat\"><b>38 bin</b>Taksim</div>), .bars (<div class=\"bars\"><div><span>Taksim</span><i style=\"width:100%\"></i><b>38 bin</b></div></div>), .tag, .ok, .warn, .bad, .dim. " +
      "Diagram: <pre class=\"mermaid\">graph TD; A-->B</pre>. Inline styles work. No scripts and no web images: the board shows it safely sandboxed. Short labels, the user's language, no emojis.",
    inputSchema: {
      title: z.string().max(100).describe("States the takeaway, not the topic"),
      html: z.string().max(200000).describe("HTML body"),
    },
  },
  async ({ title, html }) => {
    const page = embedImages(html);
    if (page.error) return fail(page.error);
    send({ type: "page", title, html: page.html });
    return ok("gösterildi");
  }
);

mcp.registerTool(
  "plan",
  {
    description: "Show the whole plan of a multi-step task as a checklist on the Lazypad board. Then use `step` with the same step text to mark progress.",
    inputSchema: {
      title: z.string().max(80).optional(),
      steps: z.array(z.string().max(120)).min(1).max(20),
    },
  },
  async ({ title, steps }) => { send({ type: "plan", title, steps }); return ok("plan gösterildi"); }
);

mcp.registerTool(
  "progress",
  {
    description: "Update a live progress bar on the Lazypad board for long work with a known size. The same label updates the same bar.",
    inputSchema: {
      label: z.string().max(80),
      current: z.number().min(0),
      total: z.number().positive(),
      unit: z.string().max(20).optional().describe("e.g. 'dosya', 'test'"),
    },
  },
  async ({ label, current, total, unit }) => { send({ type: "progress", label, current, total, unit }); return ok("güncellendi"); }
);

mcp.registerTool(
  "step",
  {
    description: "Update the progress checklist on the Lazypad board for multi-step tasks (doing when starting, done/fail when finished).",
    inputSchema: {
      label: z.string().max(120),
      status: z.enum(["doing", "done", "fail"]),
    },
  },
  async ({ label, status }) => { send({ type: "step", label, status }); return ok("güncellendi"); }
);

mcp.registerTool(
  "ask",
  {
    description: "Ask the user a decision on the Lazypad board (card + voice). ONLY for hard-to-reverse decisions or ones that are truly the user's call. The user can pick an option or type their own answer. Blocks until answered (max 10 min). Recommended option first. If nobody answers, treat it as not approved.",
    inputSchema: {
      question: z.string().max(300),
      options: z.array(z.string().max(80)).max(6).default([]).describe("Choices, recommended first. Empty for an open question"),
      multi: z.boolean().default(false).describe("Allow picking several options"),
    },
  },
  async ({ question, options, multi }, { signal }) => {
    const id = randomUUID();
    const answer = await new Promise((resolve) => {
      const settle = (value, reason) => {
        if (!pendingAsks.delete(id)) return;
        clearTimeout(timer);
        if (reason) send({ type: "ask_cancel", id, reason }); // kart açık kalmasın
        resolve(value);
      };
      const timer = setTimeout(() => settle(null, "timeout"), ASK_TIMEOUT_MS);
      signal?.addEventListener("abort", () => settle(null, "cancelled"), { once: true });
      pendingAsks.set(id, { settle, question, options, multi });
      sendAsk(id);
    });
    if (answer === null) {
      return ok("Kullanıcı süresinde cevap vermedi. Bunu onay sayma: geri alınması zor işlemi yapma. Sohbette sor ya da yalnızca geri alınabilir kısımlarla devam et.");
    }
    return ok(answer.typed ? `Kullanıcı kendi cevabını yazdı: ${answer.choice}` : `Kullanıcının seçimi: ${answer.choice}`);
  }
);

// Claude kapanınca stdin kapanır; açık WebSocket süreci ayakta tutmasın
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

connect();
await mcp.connect(new StdioServerTransport());
