// MCP sunucusu (her Claude oturumu için bir tane). Araçları merkeze iletir.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BASE, ensureHub, sleep } from "./shared.js";

const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ---------------------------------------------------------------- merkez bağlantısı
let ws = null;
const outbox = [];
const pendingAsks = new Map(); // id -> resolve

async function connect() {
  await ensureHub();
  ws = new WebSocket(BASE.replace("http", "ws") + "/session");
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", cwd: CWD }));
    while (outbox.length) ws.send(outbox.shift());
  });
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === "answer" && pendingAsks.has(m.id)) {
      pendingAsks.get(m.id)(m.choice);
      pendingAsks.delete(m.id);
    }
  });
  ws.on("close", async () => { await sleep(1000); connect(); });
  ws.on("error", () => {}); // close zaten tetiklenir
}

function send(msg) {
  const data = JSON.stringify(msg);
  if (ws?.readyState === 1) ws.send(data);
  else outbox.push(data);
}

const ok = (text) => ({ content: [{ type: "text", text }] });

// ---------------------------------------------------------------- araçlar
const INSTRUCTIONS = `CodeEasy is the user's voice + visual board. The user does NOT want to read long text: explain with visuals, not paragraphs.
Hooks already show prompts, changed files and your final message on the board automatically. Each prompt also carries a [CodeEasy] explanation mode (VISUAL / BALANCED / TEXT); follow it.
Choose the form by the content:
- flow, architecture, call order, cause→effect, states → \`draw\` (Mermaid: flowchart, sequenceDiagram, mindmap, stateDiagram), 3-10 nodes
- options, comparisons, before/after → \`show\` kind "table" or "compare"
- numbers, sizes, timings, trends → \`show\` kind "chart" (bar for categories, line for change over time)
- several takeaways → \`show\` kind "points"
Other tools:
- \`say\`: tell something important in max 2 short sentences, in the user's language. level "warn" only for things the user must know.
- \`step\`: for multi-step tasks, mark each step doing → done/fail.
- \`ask\`: ONLY for decisions that are hard to reverse or truly the user's call; decide routine things yourself. Recommended option first.
- Never use emojis in board content.
- Keep the final chat reply short: the first 1-2 sentences are read aloud as the summary, so start with the outcome.`;

const mcp = new McpServer({ name: "codeeasy", version: "0.3.0" }, { instructions: INSTRUCTIONS });

mcp.tool(
  "say",
  "Speak a SHORT message (max 2 sentences) aloud on the CodeEasy board. level 'warn' only for things the user must know. User's language, no emojis.",
  {
    text: z.string().max(400).describe("Short spoken message, max 2 sentences"),
    level: z.enum(["ok", "warn"]).default("ok"),
  },
  async ({ text, level }) => { send({ type: "say", text, level }); return ok("söylendi"); }
);

mcp.tool(
  "draw",
  "Draw a small Mermaid diagram on the CodeEasy board instead of a long text explanation (flows, architecture, cause→effect). 3-10 nodes, labels in the user's language, no emojis.",
  {
    title: z.string().max(80),
    mermaid: z.string().max(4000).describe("Mermaid source, e.g. 'graph LR; A[Giriş]-->B[Token]'"),
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
]);

mcp.tool(
  "show",
  "Show structured content on the CodeEasy board instead of writing it as text. " +
    "kind 'table' (columns + rows) for options/comparisons; 'chart' (bar|line, labels, 1-4 series, unit) for numbers; " +
    "'compare' (left/right lists, e.g. before/after or option A/B); 'points' (2-8 short takeaways). " +
    "User's language, short cells, no emojis.",
  {
    title: z.string().max(80),
    content: Show,
  },
  async ({ title, content }) => {
    const { kind, ...data } = content;
    if (kind === "chart" && data.series.some((s) => s.values.length !== data.labels.length)) {
      return ok("Hata: her serideki değer sayısı etiket sayısına eşit olmalı. Düzeltip tekrar çağır.");
    }
    send({ type: "show", kind, title, data });
    return ok("gösterildi");
  }
);

mcp.tool(
  "step",
  "Update the progress checklist on the CodeEasy board for multi-step tasks (doing when starting, done/fail when finished).",
  {
    label: z.string().max(120),
    status: z.enum(["doing", "done", "fail"]),
  },
  async ({ label, status }) => { send({ type: "step", label, status }); return ok("güncellendi"); }
);

mcp.tool(
  "ask",
  "Ask the user a decision on the CodeEasy board (card + voice). ONLY for hard-to-reverse decisions or ones that are truly the user's call. Blocks until answered (max 10 min). Recommended option first.",
  {
    question: z.string().max(300),
    options: z.array(z.string().max(80)).min(2).max(4),
  },
  async ({ question, options }) => {
    const id = randomUUID();
    const answer = await new Promise((resolve) => {
      pendingAsks.set(id, resolve);
      send({ type: "ask", id, question, options });
      setTimeout(() => { if (pendingAsks.delete(id)) resolve(null); }, 10 * 60 * 1000).unref();
    });
    return ok(answer === null
      ? "Kullanıcı cevap vermedi (zaman aşımı). Önerilen seçenekle devam et ve bunu söyle."
      : `Kullanıcının seçimi: ${answer}`);
  }
);

connect();
await mcp.connect(new StdioServerTransport());
