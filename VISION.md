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
- **Sesle geri alma:** "Son değişikliği geri al" dediğinde git checkpoint'ine döner.
- **Önem filtresi:** Her bilgi ✅ yapıldı / ⚠️ bilmen gereken / ❓ karar diye etiketlenir. Ses sadece ⚠️ ve ❓ için çalışır.
- **"Bana anlat" modu:** Bir dosyayı ya da akışı seçersin, Claude onu tahtada öğretmen gibi çizerek anlatır.

## Yol haritası
1. **MVP:** MCP sunucusu (`draw`, `say`, `ask`) + tarayıcıda tahta (Mermaid) + tarayıcı TTS'i
2. Deepgram (veya benzeri) ile kaliteli Türkçe ses + push-to-talk ile konuşma
3. Agent SDK ile Claude Code'u kendi içinde çalıştırma, söz kesme ve sesle geri alma
4. VS Code eklentisi (tahta yan panelde) + mobil tahta
