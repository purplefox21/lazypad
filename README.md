# CodeEasy

**Claude Code için sesli ve görsel tahta.** Claude çalışırken sen uzun metin okumazsın:
ne yaptığını tahtada görürsün, önemli şeyleri sesli duyarsın, kararları tek tıkla verirsin.

## Kurulum

```bash
git clone https://github.com/purplefox21/codeeasy && cd codeeasy
npm install
npm run setup
```

`setup` üç şey yapar:
1. CodeEasy'yi Claude Code'a MCP olarak ekler (terminal ve VS Code, ikisinde de çalışır)
2. Otomatik takip için hook'ları `~/.claude/settings.json`'a ekler (önce yedek alır)
3. macOS'ta Swift varsa **CodeEasy.app**'i derleyip `~/Applications`'a koyar

Sonra Claude Code'u yeniden başlat. Tahta kendiliğinden açılır.
Geri almak için: `npm run uninstall`.

## Nasıl çalışır

```
Claude oturumu A ─┐  MCP araçları + hook'lar
Claude oturumu B ─┼──► Merkez (arka planda, tek) ──► Tahta: Mac uygulaması veya tarayıcı
Claude oturumu C ─┘                                  her proje kendi sekmesinde
```

İki katman var:

| Katman | Ne gösterir | Claude'a bağlı mı |
|---|---|---|
| **Otomatik** (hook'lar) | Senin mesajın, değişen dosyalar, çalışan komutlar, "seni bekliyor" uyarısı, iş bitince kısa sesli özet | Hayır, hiç kaçmaz, token harcamaz |
| **Akıllı** (MCP araçları) | Şemalar (`draw`), önemli notlar (`say`), adımlar (`step`), karar kartları (`ask`) | Evet, Claude gerekli gördüğünde kullanır |

## Az metin, çok görsel

Claude anlatacağı şeyin türüne göre biçim seçer:

| İçerik | Tahtada |
|---|---|
| Akış, mimari, çağrı sırası, sebep-sonuç | Şema (`draw`): akış, sıra, zihin haritası, durum şeması |
| Seçenekler, karşılaştırma, önce/sonra | Tablo veya yan yana karşılaştırma (`show`) |
| Sayılar, süreler, boyutlar, eğilim | Çubuk veya çizgi grafik (`show`) |
| Birden fazla önemli nokta | Numaralı kartlar (`show`) |

**Nasıl anlatsın** ayarı (tahtada, sağ üstteki menü): *Görsel* (varsayılan, sohbette en fazla 3 satır),
*Dengeli* ya da *Metin*. Tercih her mesajda Claude'a otomatik iletilir.

O anlık istisna için ayarı değiştirmen gerekmez, mesajında söylemen yeter:
- "bunu **yazıyla / detaylı** anlat" → o mesaj için metin
- "akışı **çiz**", "**şema / grafik / tabloyla**" → o mesaj için görsel

Şemaya tıklayınca tam ekran büyür, grafiklerde "Tablo olarak gör" ile sayıları görürsün.

## Tahta

- **Sekmeler:** Her proje bir sekme. Nokta rengi durumu gösterir: mor çalışıyor, turuncu seni bekliyor.
- **Ne kadar konuşsun:** *Her şeyi* / *Önemlileri* / *Gerekince* (sadece karar ya da izin gerekince).
- **Başka sekmede olunca:** Kısaca haber verir ("magaza-api bitti"), sekmede sayaç çıkar.
  Sekmeye dönünce **Kaçırdıkların · Dinle** ile hepsini arka arkaya dinlersin.
- **Bitti kartı:** Kısa özeti okur. **Tamamını göster** ile Claude'un tam cevabını açarsın.
- **macOS bildirimi:** Claude izin ya da karar beklerken ekranın köşesinde bildirim çıkar.

| Kısayol | |
|---|---|
| `Space` | Son mesajı tekrar dinle |
| `Esc` | Sus |
| `M` | Sesi aç / kapat |
| `1`–`4` | Karar kartında seçeneği seç |
| `[` `]` | Sekmeler arasında geç |

## Uygulama mı tarayıcı mı

```bash
node src/index.js mode app       # Mac uygulamasında aç (varsa, varsayılan)
node src/index.js mode browser   # her zaman tarayıcıda aç
node src/index.js mode none      # kendiliğinden açma, ben açarım
node src/index.js open           # tahtayı şimdi aç
```

Mac uygulaması gerçek macOS cam efektiyle açılır, Apple'ın yerel ses motorunu kullanır
(tarayıcıdaki "dokun, ses açılsın" adımı yoktur) ve **her zaman üstte** düğmesi vardır.
Derlemek için Xcode Komut Satırı Araçları gerekir (`xcode-select --install`), sonra `npm run app`.

## Güvenlik

Merkez sadece `127.0.0.1`'de dinler. Başka sitelerin tarayıcı üzerinden tahtana bağlanması
ve karar kartlarını cevaplaması engellidir (origin kontrolü + özel başlık).
