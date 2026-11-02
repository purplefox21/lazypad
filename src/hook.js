// Claude Code hook'u: olayı merkeze iletir. Claude'u asla bekletmez ve bozmaz.
import { BASE, ensureHub } from "./shared.js";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", async () => {
  try {
    const h = JSON.parse(input);
    if (h.hook_event_name === "UserPromptSubmit") await ensureHub();
    const r = await fetch(`${BASE}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codeeasy": "1" },
      body: input,
      signal: AbortSignal.timeout(1500),
    });
    // UserPromptSubmit: merkez, anlatım moduna göre Claude'a ek bağlam döndürür
    const out = await r.text();
    if (out.startsWith("{")) return process.stdout.write(out, () => process.exit(0));
  } catch { /* merkez kapalıysa sessizce geç */ }
  process.exit(0);
});
