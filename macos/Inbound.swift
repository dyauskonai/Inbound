import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var backend: Process?
    private var attempts = 0
    private let baseURL = URL(string: "http://127.0.0.1:8000/")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Inbound", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(withTitle: "Save Report as PDF…", action: #selector(printReport), keyEquivalent: "p")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Inbound", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Inbound"
        window.minSize = NSSize(width: 760, height: 560)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("<body style='background:#f8f7f2;color:#183e32;font:24px system-ui;padding:60px'><h1>inbound ↘</h1><p>Connecting to your workspace…</p></body>", baseURL: nil)
        connect()
    }

    private func connect() {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    var target = self.baseURL
                    if let session = ProcessInfo.processInfo.environment["INBOUND_OPEN_SESSION"],
                       UUID(uuidString: session) != nil {
                        target = URL(string: self.baseURL.absoluteString + "#" + session)!
                    }
                    self.webView.load(URLRequest(url: target))
                    return
                }
                self.attempts += 1
                if self.attempts == 1 { self.startBackend() }
                if self.attempts < 12 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.connect() }
                } else {
                    self.webView.loadHTMLString("<body style='font:18px system-ui;padding:60px'><h1>Couldn’t connect to Inbound</h1><p>Run the “Inbound: Mac server” task in VS Code, then press ⌘R.</p></body>", baseURL: nil)
                }
            }
        }.resume()
    }

    private func startBackend() {
        guard let root = Bundle.main.object(forInfoDictionaryKey: "InboundProjectRoot") as? String else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: root + "/.venv/bin/python")
        process.arguments = [root + "/scripts/dev.py", "--lan"]
        process.currentDirectoryURL = URL(fileURLWithPath: root)
        let logURL = URL(fileURLWithPath: root + "/runtime/mac-app.log")
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        if let log = try? FileHandle(forWritingTo: logURL) {
            log.seekToEndOfFile()
            process.standardOutput = log
            process.standardError = log
        }
        do { try process.run(); backend = process } catch { NSLog("Could not launch Inbound server") }
    }

    @objc private func reload() { attempts = 0; connect() }
    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = "Inbound"
        alert.informativeText = "Hands-free capture. Evidence-linked handoff reports.\nImmerse the Bay · Local prototype"
        alert.runModal()
    }
    @objc private func printReport() {
        let operation = webView.printOperation(with: NSPrintInfo.shared)
        operation.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.host == "127.0.0.1" || url.scheme == "about" || url.scheme == "blob" {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    // Keep the server running when the window closes so phone uploads continue.
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
