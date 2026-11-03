// Tur bitince arka planda bekler. Tahtadan yazı gelirse Claude'u uyandırır:
// asyncRewake hook'u 2 koduyla çıkınca stderr'deki metin Claude'a iletilir.
import { exitWithParent, postHub, sleep } from "./shared.js";

const RETRY_MS = 3000;

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", async () => {
  let h;
  try { h = JSON.parse(input); } catch { process.exit(0); }
  if (process.env.CLAUDE_PROJECT_DIR) h.project_dir = process.env.CLAUDE_PROJECT_DIR;
  exitWithParent();
  for (;;) {
    try {
      const { status, out } = await postHub("/wait", h);
      if (status !== 200) process.exit(0);
      const m = JSON.parse(out);
      if (m.type !== "reply") process.exit(0); // kullanıcı VS Code'dan yazdı ya da oturum bitti
      return process.stderr.write(m.text, () => process.exit(2));
    } catch {
      await sleep(RETRY_MS); // merkez yeniden başlıyor olabilir
    }
  }
});
