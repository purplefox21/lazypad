# Lazypad

**Claude Code için sesli ve görsel tahta.** Claude çalışırken ne yaptığını tahtada görürsün,
önemli şeyleri sesli duyarsın, kararları tek tıkla verirsin. Claude'un tam cevabı yine sohbette (terminal ya da VS Code) durur:
tahta onun görsel kopyasıdır, yerine geçmez.

## Kurulum

```bash
git clone https://github.com/purplefox21/lazypad && cd lazypad
npm install
npm run setup
```

Node 22 veya üstü gerekir.

`setup` üç şey yapar:
1. Lazypad'i Claude Code'a MCP olarak ekler (terminal ve VS Code, ikisinde de çalışır)
2. Otomatik takip için hook'ları `~/.claude/settings.json`'a ekler (önce yedek alır)
3. macOS'ta Swift varsa **Lazypad.app**'i derleyip `~/Applications`'a koyar

Sonra Claude Code'u yeniden başlat. Tahta kendiliğinden açılır.
Geri almak için: `npm run uninstall`. Proje klasörünü taşırsan `npm run setup`'ı yeniden çalıştır.

## Nasıl çalışır

```
Claude oturumu A ─┐  MCP araçları + hook'lar
Claude oturumu B ─┼──► Merkez (arka planda, tek) ──► Tahta: Mac uygulaması veya tarayıcı
Claude oturumu C ─┘                                  her proje kendi sekmesinde
```

İki katman var:

| Katman | Ne gösterir | Claude'a bağlı mı |
|---|---|---|
| **Otomatik** (hook'lar) | Senin mesajın, Claude'un ara mesajları ve tam cevabı, değişen dosyalar, komutlar, izin istekleri, seçenekli sorular, planlar | Hayır, hiç kaçmaz. Tek token maliyeti, her mesaja eklenen tek cümlelik anlatım modu (yaklaşık 30 token) |
| **Akıllı** (MCP araçları) | Şemalar (`draw`), grafik/tablo/kod/fark/görsel/dosyalar (`show`), plan (`plan`, `step`), ilerleme çubuğu (`progress`), sesli not (`say`), karar kartı (`ask`) | Evet, Claude gerekli gördüğünde kullanır |

Hook'lar kullanıcı düzeyinde kurulur, yani makinedeki bütün Claude Code projelerinde çalışır.

## Sohbet tam, tahta görsel

Claude cevabını her zaman sohbete eksiksiz yazar. Ayrıca anlattığı şeyin türüne göre tahtaya da bir görsel koyar:

| İçerik | Tahtada |
|---|---|
| Akış, mimari, çağrı sırası, sebep-sonuç | Şema (`draw`): akış, sıra, zihin haritası, durum şeması |
| Seçenekler, karşılaştırma, önce/sonra | Tablo veya yan yana karşılaştırma (`show`) |
| Sayılar, süreler, boyutlar, eğilim | Çubuk veya çizgi grafik (`show`) |
| Birden fazla önemli nokta | Numaralı kartlar (`show`) |
| Kod parçası, değişiklik | Kod ve fark kartı (`show`) |
| Ekran görüntüsü, üretilen görsel | Görsel kartı (`show`), tıklayınca büyür |
| İlgili dosyalar | Tıklayınca VS Code'da açılan liste (`show`) |
| Çok adımlı iş | Akışta canlı plan (`plan`, `step`) ve ilerleme çubuğu (`progress`) |

**Amaç: az yazı oku, her şeyi anla.** Claude tahtayı artifact gibi özgürce kullanır: `page` ile fotoğraf, yan yana karşılaştırma, kutucuklar, çubuklar ve şemalardan oluşan sayfalar çizer.
Bilgi kaybolmasın diye uzun bir cevabın sonunda Claude'dan o cevabın **görsel özetini** tahtaya yazması istenir: sonuç, kararlar, önemli sayılar, riskler ve sonraki adımlar kalır, açıklama ve tekrar gider. Bu adım her uzun cevapta biraz token harcar; **Metin** modunda çalışmaz.
Tam metin sohbette durur; tahtada **Tamamını göster** ile açılır. Claude'un ara mesajları tek satır görünür, tıklayınca açılır. Geçmiş, merkez yeniden başlasa da geri gelir (`~/.lazypad/history.json`; görseller saklanmaz).

**Tahtada ne kadar göstersin** ayarı (tahtada, sağ üstteki menü): *Görsel* (varsayılan), *Dengeli* ya da *Metin*.
Bu ayar sohbeti kısaltmaz, yalnızca tahtaya ne kadar görsel konacağını belirler. Tercih her mesajda Claude'a otomatik iletilir.

O anlık istisna için ayarı değiştirmen gerekmez, mesajında söylemen yeter:
- "bunu **yazıyla / detaylı** anlat" → o mesaj için tahta isteğe bağlı
- "akışı **çiz**", "**şema / grafik / tabloyla**" → o mesaj için tahtaya görsel

Şemaya tıklayınca tam ekran büyür, grafiklerde "Tablo olarak gör" ile sayıları görürsün.

## Tahtadan cevap vermek

Sohbetteki her şeye tahtadan da cevap verebilirsin. VS Code'daki kutular açık kalır, **hangisi önce cevaplarsa o geçerli olur**.

| Durum | Tahtada | Claude'a nasıl ulaşır |
|---|---|---|
| Claude boşta | Alttaki yazı kutusu | Oturum uyanır, yazın sanki sen yazmışsın gibi işlenir |
| Claude çalışıyor | Alttaki yazı kutusu | Bir sonraki adımda ya da tur biterken araya girer |
| Cevap soruyla bitti | Vurgulu soru, **Evet/Hayır** ya da seçenek düğmeleri | Tek tıkla oturum uyanır |
| İzin isteği | Komutun kendisi, **İzin ver** / **Reddet** ve neden kutusu | VS Code'daki kutu kendiliğinden kapanır |
| Seçenekli soru (AskUserQuestion) | Tüm sorular, seçenekler ve "başka cevap" kutusu | VS Code'daki kutu kendiliğinden kapanır |
| Karar kartı (`ask`) | Düğmeler, çoklu seçim, serbest yazı | Claude hemen devam eder |
| Plan onayı | Planın tamamı ve düzeltme kutusu | Düzeltme iletilir; **onay yalnızca VS Code'dan** verilebilir |

Tahtadan yazdıklarını Claude sohbete tek satır alıntılar, böylece VS Code'daki konuşma da eksiksiz kalır.
Claude Esc ile durdurulduysa ya da oturum kapalıysa yazı iletilemez, kart bunu söyler: o zaman VS Code'dan yaz.

## Tahta

- **Sekmeler:** Her proje bir sekme. Nokta rengi durumu gösterir: mor çalışıyor, turuncu seni bekliyor.
  Boştaki sekmeyi üzerine gelip × ile kapatabilirsin; proje yeniden çalışınca sekme geri gelir.
- **Karar kartları:** 10 dakika içinde cevap vermezsen Claude bunu onay saymaz, işlemi yapmaz.
  Bağlantı kopsa da cevabın kaybolmaz, oturum geri dönünce iletilir.
- **Ne kadar konuşsun:** *Her şeyi* / *Önemlileri* / *Gerekince* (sadece karar ya da izin gerekince).
- **Başka sekmede olunca:** Kısaca haber verir ("magaza-api bitti"), sekmede sayaç çıkar.
  Sekmeye dönünce **Kaçırdıkların · Dinle** ile hepsini arka arkaya dinlersin.
- **Bitti kartı:** Özet cümleyi gösterir ve sesli okur, **Tamamını göster** cevabın tamamını açar.
- **Claude'un sorusu:** Cevap bir soruyla bitiyorsa soru vurgulanır ve okunur, sen yazana kadar sekme turuncu kalır.
- **macOS bildirimi:** Claude izin ya da karar beklerken ekranın köşesinde bildirim çıkar.

| Kısayol | |
|---|---|
| `Space` | Son mesajı tekrar dinle |
| `Esc` | Sus |
| `M` | Sesi aç / kapat |
| `1`–`6` | Soruda seçeneği seç (izin kartlarında kısayol yok, yanlışlıkla izin verilmesin) |
| `/` | Yazı kutusuna geç |
| `Enter` / `Shift+Enter` | Yazı kutusunda gönder / alt satır |
| `[` `]` | Sekmeler arasında geç |

## Uygulama mı tarayıcı mı

```bash
node src/index.js mode app       # Mac uygulamasında aç (varsa, varsayılan)
node src/index.js mode browser   # her zaman tarayıcıda aç
node src/index.js mode none      # kendiliğinden açma, ben açarım
node src/index.js open           # tahtayı şimdi aç
node src/index.js stop           # merkezi kapat (Claude bir sonraki işte yeniden başlatır)
```

Tarayıcıda tahtayı ilk kez `open` ile aç: erişim anahtarı böyle gelir, sonra tarayıcı hatırlar.
Şemalar internet gerektirmez, Mermaid projeyle birlikte gelir (`board/vendor`).
Port 4242 doluysa ortamda `LAZYPAD_PORT` ile başka bir port ver.

Mac uygulaması gerçek macOS cam efektiyle açılır, Apple'ın yerel ses motorunu kullanır
(tarayıcıdaki "dokun, ses açılsın" adımı yoktur) ve **her zaman üstte** düğmesi vardır.
Derlemek için Xcode Komut Satırı Araçları gerekir (`xcode-select --install`), sonra `npm run app`.

## Güvenlik

Merkez sadece `127.0.0.1`'de dinler ve her bağlantıyı denetler:

- **Erişim anahtarı:** Bağlanmak ve yazmak için `~/.lazypad/token` gerekir (yalnızca senin kullanıcın okuyabilir).
- **Origin ve Host:** Başka siteler ve `localhost`'un başka portlarındaki sayfalar bağlanamaz, DNS rebinding reddedilir.
- **Sıkı CSP:** Tahta dış adresten kod yüklemez, başka sayfanın içine gömülemez.

Aynı kullanıcıyla çalışan bir program anahtar dosyasını okuyabilir; bu, o kullanıcının kendi yetkisi içindedir.

## Geliştirme

```bash
npm test
```

Testler geçici bir HOME ve boş bir portta çalışır, gerçek ayarlarına dokunmaz.

## Lisans

MIT + [Commons Clause](https://commonsclause.com/). Kullanmak, işte kullanmak, değiştirmek ve paylaşmak serbest.
Yazılımı ya da değeri esas olarak bu yazılımdan gelen bir ürünü/hizmeti **satmak** serbest değil. Ayrıntılar: `LICENSE`.

