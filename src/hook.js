// Claude Code hook'u: olayı merkeze iletir. Claude'u asla bozmaz; merkez kapalıysa sessizce geçer.
import { ensureHub, exitWithParent, postHub } from "./shared.js";

const PERMISSION_WAIT_MS = 590_000; // settings.json'daki 600 sn sınırının altında

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", async () => {
  try {
    const h = JSON.parse(input);
    // cwd, Claude `cd` yapınca değişir; sekme proje köküne bağlı kalmalı
    if (process.env.CLAUDE_PROJECT_DIR) h.project_dir = process.env.CLAUDE_PROJECT_DIR;
    if (h.hook_event_name === "UserPromptSubmit") await ensureHub();
    // İzin isteği tahtadan cevap bekler; VS Code'daki kutu da bu sırada açıktır, hangisi önce cevaplarsa o geçerli
    const waits = h.hook_event_name === "PermissionRequest";
    if (waits) exitWithParent();
    const { out } = await postHub(waits ? "/permission" : "/hook", h, waits ? PERMISSION_WAIT_MS : 1500);
    if (out.startsWith("{")) return process.stdout.write(out, () => process.exit(0));
  } catch { /* merkez kapalıysa sessizce geç */ }
  process.exit(0);
});
