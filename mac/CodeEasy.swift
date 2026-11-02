// CodeEasy — macOS uygulaması
// Tahtayı (http://127.0.0.1:4242) gerçek macOS cam efektli bir pencerede gösterir
// ve konuşmayı Apple'ın yerel ses motoruyla (AVSpeechSynthesizer) yapar.
//
// Derleme: npm run app   (veya: xcrun swiftc -O CodeEasy.swift -framework Cocoa -framework WebKit -framework AVFoundation)

import AVFoundation
import Cocoa
import WebKit

let boardURL = URL(string: "http://127.0.0.1:" + (ProcessInfo.processInfo.environment["CODEEASY_PORT"] ?? "4242") + "/?app=1")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate,
    AVSpeechSynthesizerDelegate, NSWindowDelegate
{
    var window: NSWindow!
    var web: WKWebView!
    let synth = AVSpeechSynthesizer()
    var utteranceIds: [ObjectIdentifier: String] = [:]

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()

        // Sesleri sayfaya önceden bildir
        let voices = AVSpeechSynthesisVoice.speechVoices().map {
            ["id": $0.identifier, "name": $0.name, "lang": $0.language]
        }
        let voicesJSON = (try? JSONSerialization.data(withJSONObject: voices))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "codeeasy")
        cfg.userContentController.addUserScript(WKUserScript(
            source: "window.__ceNative = true; window.__ceVoices = \(voicesJSON);",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))

        // Gerçek cam (arkası bulanık) zemin
        let glass = NSVisualEffectView()
        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "CodeEasy"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isOpaque = false
        window.backgroundColor = .clear
        window.minSize = NSSize(width: 360, height: 420)
        window.contentView = glass
        window.delegate = self

        // Üstte 28px'lik şerit pencereyi sürüklemek için boş kalır (trafik ışıkları orada)
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 560, height: 820 - 28), configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        glass.addSubview(web)

        if !window.setFrameUsingName("CodeEasyMain") { window.center() }
        window.setFrameAutosaveName("CodeEasyMain")
        if UserDefaults.standard.bool(forKey: "pinned") { window.level = .floating }

        synth.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        load()
    }

    func load() { web.load(URLRequest(url: boardURL)) }

    // Merkez henüz çalışmıyorsa bekle ve tekrar dene
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        let html = """
            <html><body style="background:transparent;color:rgba(255,255,255,.55);font:15px -apple-system;
            display:grid;place-items:center;height:90vh;text-align:center">
            Claude Code başlayınca tahta burada açılacak.</body></html>
            """
        w.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.load() }
    }

    // Sayfadan gelen komutlar
    func userContentController(_ u: WKUserContentController, didReceive msg: WKScriptMessage) {
        guard let body = msg.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "speak":
            let u = AVSpeechUtterance(string: body["text"] as? String ?? "")
            if let id = body["voice"] as? String, let v = AVSpeechSynthesisVoice(identifier: id) {
                u.voice = v
            } else {
                u.voice = AVSpeechSynthesisVoice(language: "tr-TR")
            }
            u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.02
            if let id = body["id"] as? String { utteranceIds[ObjectIdentifier(u)] = id }
            synth.speak(u)
        case "stop":
            synth.stopSpeaking(at: .immediate)
        case "pin":
            let on = body["on"] as? Bool ?? false
            window.level = on ? .floating : .normal
            UserDefaults.standard.set(on, forKey: "pinned")
        default:
            break
        }
    }

    // Konuşma durumu → sayfadaki küre animasyonu
    func report(_ on: Bool, _ u: AVSpeechUtterance) {
        DispatchQueue.main.async { [self] in
            let key = ObjectIdentifier(u)
            let id = utteranceIds[key] ?? ""
            if !on { utteranceIds.removeValue(forKey: key) }
            let speaking = on || synth.isSpeaking
            web.evaluateJavaScript("window.__ceSpeech && window.__ceSpeech(\(on), '\(id)', \(speaking))")
        }
    }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) { report(true, u) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { report(false, u) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { report(false, u) }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    // Cmd+Q, Cmd+C/V, Cmd+R çalışsın diye basit menü
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Yenile", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "CodeEasy'den Çık", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Düzen")
        edit.addItem(withTitle: "Kopyala", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Yapıştır", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Tümünü Seç", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }
    @objc func reload() { load() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
