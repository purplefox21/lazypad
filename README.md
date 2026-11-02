# CodeEasy

**Claude Code için sesli ve görsel tahta.** Claude çalışırken uzun metin yazmak yerine
tahtaya şema çizer, önemli şeyleri sesli söyler ve kararları tek tıklık kartlarla sorar.
Kaçırdığın her cümleyi geri sarıp tekrar dinleyebilirsin.

## Kurulum

```bash
git clone https://github.com/purplefox21/codeeasy && cd codeeasy
npm install
npm run setup
```

Bitti. Claude Code'u başlattığında tahta tarayıcıda kendiliğinden açılır
(açılmazsa adres: **http://localhost:4242**). Ekrana bir kere dokun, ses açılsın.

Kurallar sunucunun içinde gömülü. CLAUDE.md'ye bir şey eklemen gerekmez,
Claude bağlandığı anda "kısa yaz, çiz, konuş, gereksiz soru sorma" kurallarını alır.

## Kullanım

| Kısayol | Ne yapar |
|---|---|
| `Space` | Son mesajı tekrar dinle |
| `Esc` | Sus |
| `M` | Sesi aç / kapat |
| `1`–`4` | Açık karar kartında seçeneği seç |

Ses, macOS'ta Apple'ın kendi sesleriyle çalışır. Sağ üstteki menüden Türkçe sesi
(örneğin Yelda) seç, seçimin hatırlanır.

## Yol haritası

`VISION.md`: Deepgram ile daha kaliteli ses, sesle konuşma (push-to-talk),
"bana anlat" modu, telefon bildirimi, VS Code yan paneli.
