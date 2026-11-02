# CodeEasy 🎧

**Claude Code için sesli + görsel tahta.** Claude çalışırken uzun metin yazmak yerine
tahtaya **şema çizer**, önemli şeyleri **sesli söyler** ve kararları **tek tuşluk kartlarla** sorar.
Söylediklerini zaman çizgisinden **geri sarıp tekrar dinleyebilirsin**.

## Kurulum (2 dakika)

```bash
git clone https://github.com/purplefox21/codeeasy && cd codeeasy
npm install
```

Claude Code'a bağla (proje klasöründe çalıştır):

```bash
claude mcp add codeeasy -- node /TAM/YOL/codeeasy/src/index.js
```

Claude Code'u başlattığında tahta kendiliğinden tarayıcıda açılır
(açılmazsa: **http://localhost:4242**). Ses, macOS'ta Apple'ın kendi
sesleriyle çalışır — üstteki menüden Türkçe sesi (örn. **Yelda**) seç.

## Claude'a kuralları öğret

Projenin `CLAUDE.md` dosyasına şunu ekle:

```markdown
## CodeEasy kuralları
- Çalışırken her anlamlı adımda `step` çağır (başlarken doing, bitince done/fail).
- Önemli bilgileri `say` ile söyle: en fazla 2 cümle. Önemliyse level=warn.
- Akış, mimari, sebep→sonuç gibi şeyleri uzun metinle DEĞİL `draw` ile şema çizerek anlat.
- Sadece geri alınması zor kararları `ask` ile sor; rutin kararları kendin ver.
- Sohbete uzun metin yazma: en fazla 3-5 satır özet yeter, gerisi tahtada.
```

## Tahtada neler var

| | |
|---|---|
| 🗺️ Şemalar | Claude Mermaid ile çizer, tahta anında gösterir |
| 🔊 Sesli anlatım | Her `say` seslendirilir; ⚠️ uyarılar sarı çizgiyle işaretlenir |
| ▶️ Tekrar dinle | Kaçırdığın her cümleyi zaman çizgisinden geri sarıp dinlersin |
| ❓ Karar kartları | Önerilen seçenek ilk sırada, tek tıkla cevaplarsın |
| ⏳ Adımlar | Sol panelde canlı ilerleme listesi |
| ✋ Dur | Konuşmayı anında keser; 🔇 ile tamamen susturursun |

## Yol haritası

`VISION.md` dosyasına bak: Deepgram ile daha kaliteli ses, push-to-talk ile
sesle konuşma, "bana anlat" modu, telefon bildirimi, VS Code yan paneli.
