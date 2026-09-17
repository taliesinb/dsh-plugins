// DSH Dock app — a thin WKWebView wrapper around the DSH Web GUI served over the
// tailnet (https://<node>.ts.net/dsh/). Replaces Safari's "Add to Dock" web app,
// which authenticates with a 30-day cookie it can never renew (no URL bar) and
// cannot be created without Safari's private template-app entitlement.
//
// What it does beyond loading a URL:
//   - picks the entry point on every launch: the tailnet URL when it answers
//     (any HTTP status — the always-on relay answers 503 while DSH boots), else
//     the relay's loopback listener with the standing token from
//     $DSH_HOME/tailscale-remote.json, else an offline page that retries;
//   - sets `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }` at document
//     start so the shell treats the page as the operator's machine
//     (`ctx.connection.isLoopback`: Settings persist on the host);
//   - opens links that leave the DSH mount (other ports, other hosts, and
//     every window.open) in the default browser instead of a new window;
//   - persistent data store, standard menu bar (⌘R reload, zoom, full screen,
//     "Open in Browser"), remembered window frame, Web Inspector enabled
//     (Safari ▸ Develop ▸ <this Mac> ▸ DSH), downloads into ~/Downloads.
//
// Configuration is `Contents/Resources/dsh-dock-app.json`, written by the
// installer (dock-app.mjs):
//   { "name": "DSH", "url": "https://node.ts.net/dsh/",
//     "fallbackUrl": "http://127.0.0.1:3083/", "tokenFile": "/Users/me/.dsh/tailscale-remote.json" }
//
// Built by dock-app/build.mjs with swiftc (Command Line Tools suffice; no Xcode).

import Cocoa
import WebKit

struct DockConfig: Decodable {
    var name: String
    var url: String
    var fallbackUrl: String?
    var tokenFile: String?

    static func load() -> DockConfig {
        if let url = Bundle.main.url(forResource: "dsh-dock-app", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let config = try? JSONDecoder().decode(DockConfig.self, from: data) {
            return config
        }
        return DockConfig(name: "DSH", url: "http://127.0.0.1:3080/", fallbackUrl: nil, tokenFile: nil)
    }
}

/// Matches URLs that belong to the app: same origin as one of the entry points
/// and inside its path prefix (`/dsh/`). Everything else is "foreign".
struct Scope {
    let origins: [(scheme: String, host: String, port: Int, pathPrefix: String)]

    init(urls: [URL]) {
        origins = urls.map { url in
            let scheme = url.scheme ?? "https"
            let port = url.port ?? (scheme == "https" ? 443 : 80)
            var prefix = url.path
            if !prefix.hasSuffix("/") { prefix += "/" }
            return (scheme, (url.host ?? "").lowercased(), port, prefix)
        }
    }

    func contains(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        let host = (url.host ?? "").lowercased()
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        let path = url.path.isEmpty ? "/" : url.path
        return origins.contains { origin in
            origin.scheme == scheme && origin.host == host && origin.port == port
                && (path == String(origin.pathPrefix.dropLast()) || path.hasPrefix(origin.pathPrefix))
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, NSWindowDelegate {
    let config = DockConfig.load()
    var window: NSWindow!
    var webView: WKWebView!
    var scope: Scope!
    var titleObservation: NSKeyValueObservation?
    var showingOfflinePage = false
    var retryTimer: Timer?
    var connecting = false

    var remoteURL: URL { URL(string: config.url)! }
    var fallbackBase: URL? { config.fallbackUrl.flatMap(URL.init(string:)) }

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        scope = Scope(urls: [remoteURL] + (fallbackBase.map { [$0] } ?? []))

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "DSHDock/1.0"
        configuration.preferences.isElementFullscreenEnabled = true
        let ownsHost = WKUserScript(
            source: "globalThis.__DSH_TRANSPORT__=Object.assign(globalThis.__DSH_TRANSPORT__||{},{ownsHost:true});",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        configuration.userContentController.addUserScript(ownsHost)
        configuration.userContentController.add(self, name: "dshDock")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let self else { return }
            let title = (view.title ?? "").trimmingCharacters(in: .whitespaces)
            self.window.title = title.isEmpty ? self.config.name : title
        }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = config.name
        window.titlebarAppearsTransparent = false
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 480, height: 320)
        window.contentView = webView
        window.delegate = self
        window.setFrameAutosaveName("dsh-dock-app.main")
        if !window.setFrameUsingName("dsh-dock-app.main") { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        connect()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        if showingOfflinePage { connect() }
    }

    // MARK: entry point selection

    /// Probe the tailnet URL; any HTTP answer (even the relay's 503 splash) means "reachable".
    func probe(_ url: URL, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: .ephemeral)
        session.dataTask(with: request) { _, response, _ in
            DispatchQueue.main.async { completion(response is HTTPURLResponse) }
            session.finishTasksAndInvalidate()
        }.resume()
    }

    func fallbackURL() -> URL? {
        guard let base = fallbackBase else { return nil }
        guard let file = config.tokenFile, let data = FileManager.default.contents(atPath: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String, !token.isEmpty else { return nil }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url
    }

    @objc func connect() {
        if connecting { return }
        connecting = true
        retryTimer?.invalidate()
        probe(remoteURL) { [weak self] reachable in
            guard let self else { return }
            self.connecting = false
            if reachable {
                self.showingOfflinePage = false
                self.webView.load(URLRequest(url: self.remoteURL))
                return
            }
            if let fallback = self.fallbackURL() {
                self.probe(fallback) { [weak self] localReachable in
                    guard let self else { return }
                    if localReachable {
                        self.showingOfflinePage = false
                        self.webView.load(URLRequest(url: fallback))
                    } else {
                        self.showOffline(reason: "Neither the tailnet address nor the local relay answers. Is Tailscale connected? Is the relay LaunchAgent loaded?")
                    }
                }
            } else {
                self.showOffline(reason: "The tailnet address does not answer and no local fallback is configured. Is Tailscale connected?")
            }
        }
    }

    func showOffline(reason: String) {
        showingOfflinePage = true
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><title>\(config.name)</title>
        <style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#fafafa;color:#222}
        @media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#e5e5e7}}main{max-width:34em;padding:2em;text-align:center}h1{font-size:1.25em;font-weight:600}
        p{color:#666}@media (prefers-color-scheme:dark){p{color:#a1a1a6}}code{font:.92em ui-monospace,Menlo,monospace}
        button{font:inherit;padding:.4em 1.1em;border-radius:8px;border:1px solid #8884;background:#3b82f6;color:#fff;cursor:pointer}</style></head>
        <body><main><h1>DSH is unreachable</h1><p>\(reason)</p><p><code>\(config.url)</code></p>
        <p><button onclick="webkit.messageHandlers.dshDock.postMessage('retry')">Try again</button></p>
        <p style="font-size:.9em">Retrying automatically every 5 seconds.</p></main></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in self?.connect() }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "dshDock", (message.body as? String) == "retry" { connect() }
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { decisionHandler(.allow); return }
        // Only user-initiated top-level navigations are subject to the scope rule;
        // redirects and in-scope loads (including the token exchange) pass.
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if isMainFrame && !scope.contains(url) {
            if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil || navigationAction.navigationType == .other {
                if url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" {
                    NSWorkspace.shared.open(url)
                    decisionHandler(.cancel)
                    return
                }
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        if let http = navigationResponse.response as? HTTPURLResponse, navigationResponse.isForMainFrame,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"), disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return } // frame load interrupted (download)
        showOffline(reason: nsError.localizedDescription)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open / target=_blank: in-scope pages open in this window, anything else in the browser.
        if let url = navigationAction.request.url {
            if scope.contains(url) { webView.load(URLRequest(url: url)) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: downloads

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        var target = downloads.appendingPathComponent(suggestedFilename)
        let stem = target.deletingPathExtension().lastPathComponent
        let ext = target.pathExtension
        var counter = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = downloads.appendingPathComponent(ext.isEmpty ? "\(stem) \(counter)" : "\(stem) \(counter).\(ext)")
            counter += 1
        }
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        DistributedNotificationCenter.default().post(name: NSNotification.Name("com.apple.DownloadFileFinished"), object: nil)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert()
        alert.messageText = "Download failed"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    // MARK: menu

    @objc func reload() { if showingOfflinePage { connect() } else { webView.reloadFromOrigin() } }
    @objc func openInBrowser() { NSWorkspace.shared.open(webView.url.flatMap { scope.contains($0) ? $0 : nil } ?? remoteURL) }
    @objc func copyURL() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString((webView.url ?? remoteURL).absoluteString, forType: .string)
    }
    @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 3) }
    @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
    @objc func zoomReset() { webView.pageZoom = 1 }
    @objc func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: config.name,
            .credits: NSAttributedString(string: "Thin WKWebView wrapper for the DSH Web GUI.\n\(config.url)"),
        ])
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "About \(config.name)", action: #selector(showAbout), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(config.name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(config.name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Reconnect", action: #selector(connect), keyEquivalent: "")
        view.addItem(.separator())
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        view.addItem(.separator())
        let openInBrowser = view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o")
        openInBrowser.keyEquivalentModifierMask = [.command, .shift]
        let copy = view.addItem(withTitle: "Copy Address", action: #selector(copyURL), keyEquivalent: "c")
        copy.keyEquivalentModifierMask = [.command, .shift]
        view.addItem(.separator())
        let fullScreen = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
