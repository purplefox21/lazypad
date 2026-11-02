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
const INSTRUCTIONS = `CodeEasy is the user's voice + visual board. The user does NOT want to read long text.
Hooks already show prompts, changed files and your final message on the board automatically, so use these tools only where they add value:
- \`say\`: tell something important in max 2 short sentences, in the user's language. level "warn" only for things the user must know.
- \`draw\`: explain flows, architecture, cause→effect with a small Mermaid diagram (3-10 nodes) instead of long text.
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
