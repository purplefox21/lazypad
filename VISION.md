# CodeEasy: kodlamanın sesli ve görsel kokpiti

> Claude çalışır, **tahtaya çizer, sesli anlatır.** Sen konuşursun ya da tek tuşla karar verirsin.
> Okuma yok, uzun metin yok, karar yorgunluğu yok.

## Sorun
- Claude çok uzun yazıyor ve önemli bilgi kalabalığın içinde kayboluyor.
- Sürekli karar istiyor ve bu insanı yoruyor.
- Yazmak, okumak ve anlamak ayrı ayrı efor istiyor.

## Çözüm: 4 parça

```
 🎤 Sen (ses / buton)
        │
        ▼
 ┌─────────────────────┐      ┌────────────────────────────┐
 │  CodeEasy Beyni     │◄────►│  Claude Code (Agent SDK)   │
 │  (yerel sunucu)     │      │  + codeeasy MCP araçları:  │
 │  STT · TTS · olay   │      │  draw() say() ask() step() │
 └─────────┬───────────┘      └────────────────────────────┘
           │ WebSocket
           ▼
 ┌─────────────────────┐
 │  🖥️ Tahta Ekranı     │  2. monitör, tablet ya da telefon
 │  canlı şema + ses   │  çizerken anlatır
 │  karar kartları     │  [Evet] [Hayır] [Detay]
 └─────────────────────┘
```

| Parça | Görevi |
|---|---|
| **MCP araçları** | Neyin önemli olduğuna Claude karar verir: `draw` ile şema çizer, `say` ile 1–2 cümle söyler, `ask` ile karar kartı açar, `step` ile ilerlemeyi gösterir |
| **Beyin** | Claude Code'u Agent SDK ile çalıştırır. Konuşmayı metne (STT) ve metni konuşmaya (TTS) çevirir, olayları tahtaya iletir |
| **Tahta** | Web sayfası. Şemayı adım adım çizer ve aynı anda seslendirir. Karar kartlarını gösterir |
| **Kurallar** | Claude'a şu talimatlar verilir: "Ekrana en fazla 3 satır yaz. Önemli olanı çiz. Sadece geri alınması zor kararları sor." |

## Akıllı özellikler
- **Söz kesme:** Claude konuşurken araya girebilirsin ("dur, onu yapma") ve Claude hemen susar.
- **Geri sarma:** Her söylenen şey kayıtlı kalır; tahtadaki zaman çizgisinden "▶️ tekrar dinle" ile geri sarıp dinlersin (podcast gibi).
- **Önem filtresi:** Her bilgi ✅ yapıldı / ⚠️ bilmen gereken / ❓ karar diye etiketlenir. Ses sadece ⚠️ ve ❓ için çalışır.
- **"Bana anlat" modu:** Bir dosyayı ya da akışı seçersin, Claude onu tahtada öğretmen gibi çizerek anlatır.

## Form: MCP sunucusu
Ürün bir **MCP sunucusu** olarak yaşar: `claude mcp add codeeasy` ile Claude Code'a bağlanır (VS Code içinde de terminalde de aynı). Tahta, sunucunun açtığı yerel bir web sayfasıdır; VS Code eklentisi sonradan sadece bu sayfayı yan panelde gösteren ince bir kabuk olur.

## Durum (v0.3)
Bitenler: MCP araçları, otomatik takip (hook'lar), çok projeli sekmeli tahta, Mac uygulaması
(cam pencere, yerel ses, her zaman üstte), kaçırılanları dinleme, konuşma seviyesi, macOS bildirimleri.

## Yol haritası
1. **MVP:** MCP sunucusu (`draw`, `say`, `ask`) + tarayıcıda tahta (Mermaid) + Apple sistem sesi (macOS `say`, TR) + geri sarılabilir ses zaman çizgisi
2. Deepgram (veya benzeri) ile daha kaliteli Türkçe ses + push-to-talk ile konuşma
3. Agent SDK ile Claude Code'u kendi içinde çalıştırma, söz kesme ve sesle geri alma
4. VS Code eklentisi (tahta yan panelde) + mobil tahta
