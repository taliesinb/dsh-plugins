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
//   - carries its own identity into the page: `globalThis.__DSH_DOCK__ =
//     { name, glyphColor }` plus a `<style>` that renames the sidebar wordmark
//     ("DSH Local Build" → the app name) and colours the whale like the Dock
//     icon, and titles the window with the app name instead of the client's
//     generic product title. The same rules the tali-instance-identity DSH
//     plugin injects server-side (plugins/instance-identity/index.js), so an
//     instance whose server lacks that plugin (a remote Mac) still reads
//     right inside its Dock app; the wrapper's rules are `!important`, so
//     the app name wins over the server's label inside the app;
//   - opens links that leave the DSH mount (other ports, other hosts, and
//     every window.open) in the default browser instead of a new window;
//   - makes `localhost` / `127.0.0.1` links work: they name the *remote's*
//     loopback (an agent's dev server), so before such a URL loads the app
//     forwards that port from the DSH host to this Mac over one WebSocket per
//     connection (PortForward.swift; forward.mjs on the host) and lets the
//     navigation proceed — the URL works verbatim. View ▸ Forwarded Ports
//     lists and closes them;
//   - View ▸ Desktop / Mobile: a layout switch for trialing phone styling on
//     the Mac. Mobile stamps `<html data-dsh-view="mobile">` (document-start
//     script + live, persisted in UserDefaults so it survives reloads and
//     relaunches) — the hook plugins such as tali-phone-ui key their phone
//     rules on beside their `max-width` media query — and resizes the window
//     to iPhone content size (390×844) so the media queries fire for real.
//     Desktop clears the attribute and restores the remembered frame;
//   - <App> ▸ Settings… (⌘,) toggles the GUI's Settings panel. Safari swallows
//     ⌘, before the page sees it (why the tali-settings-shortcut plugin ships
//     ⌘.), but this wrapper owns its menu bar, so the standard macOS chord
//     can reach the page: the action hands the plugin its ⌘. chord as a
//     synthetic keydown and, when no plugin claims it, clicks the sidebar's
//     Settings trigger / the panel's close button itself (same selectors);
//   - integrated title bar: the title bar is transparent and title-less, the
//     page fills the window, the traffic lights sit at (16, 18) like the
//     upstream Electron desktop shell's, and the window material shows
//     through the page's sidebar column (View ▸ Window Material: Frosted =
//     the standard sidebar vibrancy blurring the desktop behind the window;
//     Liquid Glass = the same with an NSGlassEffectView under the page,
//     macOS 26+; the wrapper also thins the client's sidebar tint to 18% so
//     the material is what one sees). The page is told it runs in the macOS desktop
//     shell (`<html data-platform="darwin">`, the mark the shipped client's
//     hiddenInset layout keys on: 52px sidebar top strip with the collapse
//     toggle beside the lights, header controls when the sidebar is closed,
//     transparent sidebar column). WKWebView ignores `-webkit-app-region`,
//     so a document-start script reports mousedowns on the client's drag
//     regions (sidebar top strip, conversation title row) and the wrapper
//     drags the window (double-click follows the System Settings title-bar
//     action). The page's theme choice (`html[data-ds-theme-source]`) sets
//     the window appearance so the vibrancy material follows it;
//   - persistent data store, standard menu bar (⌘R reload, zoom, full screen,
//     "Open in Browser"), remembered window frame, Web Inspector enabled
//     (Safari ▸ Develop ▸ <this Mac> ▸ DSH), downloads into ~/Downloads.
//
// Configuration is `Contents/Resources/dsh-dock-app.json`, written by the
// installer (dock-app.mjs):
//   { "name": "DSH", "url": "https://node.ts.net/dsh/",
//     "fallbackUrl": "http://127.0.0.1:3083/", "tokenFile": "/Users/me/.dsh/tailscale-remote.json",
//     "glyphColor": "#0090FF" }   // icon glyph colour; absent or #000000 = stock whale in the page
//
// Built by dock-app/build.mjs with swiftc (Command Line Tools suffice; no Xcode).

import Cocoa
import WebKit

struct DockConfig: Decodable {
    var name: String
    var url: String
    var fallbackUrl: String?
    var tokenFile: String?
    var glyphColor: String?
    /// Present in the bundled app (DSH.dmg): run the server from Contents/Resources (EmbeddedServer.swift).
    var embedded: EmbeddedSpec?
    /// Present in the bundled app: check GitHub Releases for newer builds (Updater.swift).
    var update: UpdateSpec?

    /// Product title the shipped client uses for the wordmark and `document.title`.
    static let genericProductTitle = "DSH Local Build"

    /// Both desktop wrappers run this bundled script with their own identity.
    func identityScript() -> String {
        guard let url = Bundle.main.url(forResource: "desktop-branding", withExtension: "js"),
              let script = try? String(contentsOf: url, encoding: .utf8) else {
            NSLog("DSH: missing desktop-branding.js resource")
            return ""
        }
        let payload = (try? JSONSerialization.data(withJSONObject: ["name": name, "glyphColor": glyphColor ?? ""]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return "\(script)(\(payload));"
    }

    static func load() -> DockConfig {
        if let url = Bundle.main.url(forResource: "dsh-dock-app", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let config = try? JSONDecoder().decode(DockConfig.self, from: data) {
            return config
        }
        return DockConfig(name: "DSH", url: "http://127.0.0.1:3080/", fallbackUrl: nil, tokenFile: nil, glyphColor: nil, embedded: nil, update: nil)
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
        mountBase(for: url) != nil
    }

    /// The mount directory (`https://node/dsh/user/`) of the entry point a URL belongs to, or nil when foreign.
    func mountBase(for url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        let host = (url.host ?? "").lowercased()
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        let path = url.path.isEmpty ? "/" : url.path
        guard let origin = origins.first(where: { origin in
            origin.scheme == scheme && origin.host == host && origin.port == port
                && (path == String(origin.pathPrefix.dropLast()) || path.hasPrefix(origin.pathPrefix))
        }) else { return nil }
        var components = URLComponents()
        components.scheme = origin.scheme
        components.host = origin.host
        if origin.port != (origin.scheme == "https" ? 443 : 80) { components.port = origin.port }
        components.path = origin.pathPrefix
        return components.url
    }
}

/// View ▸ Desktop / Mobile. The raw value is what the page sees in
/// `document.documentElement.dataset.dshView` (absent for desktop).
enum ViewMode: String {
    case desktop, mobile

    static let defaultsKey = "dsh-dock-app.viewMode"
    static let desktopFrameKey = "dsh-dock-app.desktopFrame"
    /// iPhone 14/15 CSS viewport; matches the phone-ui plugin's ≤640px query with room to spare.
    static let mobileContentSize = NSSize(width: 390, height: 844)

    static var stored: ViewMode {
        get { UserDefaults.standard.string(forKey: defaultsKey).flatMap(ViewMode.init(rawValue:)) ?? .desktop }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey) }
    }

    /// Document-start script: stamp the flag before the client's first paint
    /// and publish it beside the app identity (`__DSH_DOCK__.view`).
    var script: String {
        let set = self == .mobile
            ? "document.documentElement.setAttribute('data-dsh-view','mobile');"
            : "document.documentElement.removeAttribute('data-dsh-view');"
        return "(function(){\(set)globalThis.__DSH_DOCK__=Object.assign(globalThis.__DSH_DOCK__||{},{view:'\(rawValue)'});})();"
    }
}

/// The main window. With the traffic lights moved out of their stock spot
/// (AppDelegate.layoutTrafficLights), AppKit's own rollover tracking no longer
/// covers them and the buttons would never draw their × – + glyphs: the frame
/// asks the window `_mouseInGroup:` (private) before drawing each button, and
/// the delegate keeps `pointerOverTrafficLights` current from a tracking area
/// over the moved group — the same arrangement Electron's `trafficLightPosition`
/// uses.
final class DockWindow: NSWindow {
    var pointerOverTrafficLights = false

    @objc(_mouseInGroup:) func mouseInGroup(_ button: NSButton) -> Bool { pointerOverTrafficLights }
}

/// View ▸ Window Material: what the transparent page sits on.
enum WindowMaterial: String {
    /// `NSVisualEffectView` sidebar material, behind-window blur (default).
    case frosted
    /// The same blur with an `NSGlassEffectView` (macOS 26+) between it and the page.
    case liquidGlass

    static let defaultsKey = "dsh-dock-app.windowMaterial"

    static var stored: WindowMaterial {
        get { UserDefaults.standard.string(forKey: defaultsKey).flatMap(WindowMaterial.init(rawValue:)) ?? .frosted }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, NSWindowDelegate, NSMenuDelegate {
    let config = DockConfig.load()
    var window: DockWindow!
    var webView: WKWebView!
    var viewMode: ViewMode = ViewMode.stored
    var desktopMenuItem: NSMenuItem!
    var mobileMenuItem: NSMenuItem!
    var windowMaterial: WindowMaterial = WindowMaterial.stored
    var frostedMenuItem: NSMenuItem!
    var liquidGlassMenuItem: NSMenuItem!
    var scope: Scope!
    var forwarder: PortForwarder!
    let forwardedPortsMenu = NSMenu(title: "Forwarded Ports")
    /// Last refusal shown per remote port, so a failing iframe does not stack alerts.
    private var lastForwardAlert: [Int: Date] = [:]
    var titleObservation: NSKeyValueObservation?
    var showingOfflinePage = false
    var retryTimer: Timer?
    var connecting = false
    /// Embedded mode (bundled app): the server this process runs, and the tokened URL it announced.
    var embedded: EmbeddedServer?
    var embeddedURL: URL?
    var embeddedRestarts = 0
    var updater: Updater?

    /// Entry point: the announced embedded URL, else the configured one (a placeholder in embedded mode until the server speaks).
    var remoteURL: URL { embeddedURL ?? URL(string: config.url)! }
    var fallbackBase: URL? { config.fallbackUrl.flatMap(URL.init(string:)) }

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installSnapshotSignal()
        installTerminateSignal()
        scope = Scope(urls: [remoteURL] + (fallbackBase.map { [$0] } ?? []))
        forwarder = PortForwarder(endpointBase: { [weak self] in self?.currentMountBase() }, log: { [weak self] line in self?.appendLog(line) })
        buildMenu()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "DSHDock/1.0"
        configuration.preferences.isElementFullscreenEnabled = true
        installUserScripts(into: configuration.userContentController)
        configuration.userContentController.add(self, name: "dshDock")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = true
        // The client paints `html, body` transparent under data-platform=darwin so
        // the window's vibrancy reaches its sidebar column; the view must not
        // paint an opaque base behind the page. (Private `_drawsBackground`,
        // reached through KVC — the same switch Electron's transparent windows use.)
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let self else { return }
            // The client titles the page "<session> — DSH Local Build"; this window is
            // named after the app (servers without tali-instance-identity still say so).
            let title = (view.title ?? "")
                .replacingOccurrences(of: DockConfig.genericProductTitle, with: self.config.name)
                .trimmingCharacters(in: .whitespaces)
            self.window.title = title.isEmpty ? self.config.name : title
        }

        window = DockWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = config.name
        // Integrated title bar (Electron `titleBarStyle: 'hiddenInset'`): no title
        // text, no bar fill, no separator; the page owns the top edge and the
        // traffic lights float over it (layoutTrafficLights).
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        window.tabbingMode = .disallowed
        // Narrow enough for View ▸ Mobile's 390px phone width.
        window.minSize = NSSize(width: 360, height: 320)
        // Window material behind the transparent page (View ▸ Window Material):
        // the client's centre column paints its own opaque base, only the
        // sidebar column lets the material through.
        webView.autoresizingMask = [.width, .height]
        installBackdrop()
        window.delegate = self
        window.setFrameAutosaveName("dsh-dock-app.main")
        if !window.setFrameUsingName("dsh-dock-app.main") { window.center() }
        layoutTrafficLights()
        syncViewModeMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let spec = config.embedded {
            startEmbedded(spec)
        } else {
            connect()
        }
        if let spec = config.update {
            let updater = Updater(spec: spec, appName: config.name, log: { [weak self] line in self?.appendLog(line) })
            updater.schedule()
            self.updater = updater
        }
    }

    @objc func checkForUpdates() { updater?.checkNow() }

    // MARK: embedded server

    func startEmbedded(_ spec: EmbeddedSpec) {
        let server = EmbeddedServer(spec: spec, resources: Bundle.main.resourceURL!, log: { [weak self] line in self?.appendLog(line) })
        server.onReady = { [weak self] url in
            guard let self else { return }
            self.embeddedURL = url
            self.embeddedRestarts = 0
            // The scope was built from the placeholder URL; the real port may differ (`--port 0`).
            self.scope = Scope(urls: [url])
            self.showingOfflinePage = false
            self.webView.load(URLRequest(url: url))
        }
        server.onExit = { [weak self] status, tail in
            guard let self else { return }
            self.embeddedURL = nil
            let detail = tail.isEmpty ? "" : "<pre style=\"text-align:left;font-size:.8em;white-space:pre-wrap\">" + tail.joined(separator: "\n").htmlEscaped + "</pre>"
            self.showOffline(reason: "The bundled DSH server exited (status \(status)). Log: <code>\(self.embedded?.logFile.path ?? "")</code>" + detail, autoRetry: false)
        }
        embedded = server
        showingOfflinePage = true
        webView.loadHTMLString("<!doctype html><html><head><meta charset=utf-8><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px -apple-system,system-ui;color:#888}</style></head><body>Starting DSH…</body></html>", baseURL: nil)
        server.start()
    }

    /// All document-start scripts, in order. Re-run (after `removeAllUserScripts`)
    /// when the view mode changes so the next load already carries the flag.
    func installUserScripts(into controller: WKUserContentController) {
        controller.removeAllUserScripts()
        let ownsHost = WKUserScript(
            source: "globalThis.__DSH_TRANSPORT__=Object.assign(globalThis.__DSH_TRANSPORT__||{},{ownsHost:true});",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        controller.addUserScript(ownsHost)
        // The client's macOS-desktop layout mark (apps/desktop's preload sets the
        // same attribute): hiddenInset sidebar strip, header controls for the
        // closed sidebar, transparent page background for the vibrancy.
        controller.addUserScript(WKUserScript(
            source: Self.darwinPlatformScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(
            source: Self.titlebarBridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(
            source: config.identityScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(
            source: viewMode.script,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        // Page diagnostics → ~/Library/Logs/DSH Dock/<app>.log: uncaught errors,
        // unhandled rejections and console.error/warn. The wrapper has no
        // dev-tools shortcut, so this is how a "it only happens in the app"
        // report becomes readable (Safari ▸ Develop remains available too).
        controller.addUserScript(WKUserScript(
            source: """
            (() => {
              const post = (level, text) => { try { webkit.messageHandlers.dshDock.postMessage({ type: 'console', level, text: String(text).slice(0, 2000) }) } catch {} };
              window.addEventListener('error', e => post('error', (e.message || 'error') + (e.filename ? ' @ ' + e.filename + ':' + e.lineno : '')));
              window.addEventListener('unhandledrejection', e => post('unhandled', e.reason && (e.reason.stack || e.reason.message || e.reason)));
              for (const level of ['error', 'warn']) { const orig = console[level]; console[level] = (...a) => { post(level, a.map(x => { try { return typeof x === 'string' ? x : (x && x.stack) || JSON.stringify(x) } catch { return String(x) } }).join(' ')); orig.apply(console, a) } }
              // Menus: in WKWebView the mousedown default on a Radix menu row moves focus to <body> (the row
              // is not focused on hover as in Chrome/Safari), the menu's focus-outside guard unmounts it
              // before pointerup, and nothing is selected (traced 2026-09-21). Suppress that default for
              // radio/checkbox rows — plain menuitems ("Model ›", which swaps the menu content) work unaided.
              const rowOf = e => e.target && e.target.closest ? e.target.closest('[role="menuitemradio"],[role="menuitemcheckbox"]') : null;
              document.addEventListener('mousedown', e => { if (rowOf(e)) e.preventDefault() }, true);
              // Transport: failed or non-2xx fetches and WebSocket closes — a request the page drops quietly shows up here.
              const origFetch = window.fetch.bind(window);
              const urlOf = input => typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
              window.fetch = async (input, init) => { const url = urlOf(input); const method = (init && init.method) || (input && input.method) || 'GET'; try { const res = await origFetch(input, init); if (res.status >= 400) post('net', method + ' ' + url + ' → ' + res.status); else if (method !== 'GET') post('net', method + ' ' + url + ' → ' + res.status); if (res.status < 400 && method !== 'GET' && /application\\/json/.test(res.headers.get('content-type') || '')) { res.clone().text().then(t => { if (/"ok":\\s*false|"error"/.test(t)) post('rpc', method + ' ' + url + ' → ' + t.slice(0, 600)) }).catch(() => {}) } return res } catch (e) { post('net', method + ' ' + url + ' → failed: ' + (e && e.message || e)); throw e } };
              const OrigWS = window.WebSocket; window.WebSocket = function (url, protocols) { const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols); ws.addEventListener('close', ev => post('net', 'ws close ' + url + ' code ' + ev.code + (ev.reason ? ' ' + ev.reason : ''))); ws.addEventListener('error', () => post('net', 'ws error ' + url)); ws.addEventListener('message', ev => { if (typeof ev.data === 'string' && /"ok":\\s*false|"error"/.test(ev.data)) post('rpc', 'ws ← ' + ev.data.slice(0, 600)) }); const origSend = ws.send.bind(ws); ws.send = data => { if (typeof data === 'string' && /selection|model/i.test(data)) post('rpc', 'ws → ' + data.slice(0, 300)); return origSend(data) }; return ws }; window.WebSocket.prototype = OrigWS.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
    }

    /// `<html data-platform="darwin">`, set before the client's first paint. At
    /// document start the root element exists; the DOMContentLoaded fallback
    /// mirrors apps/desktop/src/preload-platform.ts.
    static let darwinPlatformScript = """
    (function(){var m=function(){document.documentElement.dataset.platform='darwin'};if(document.documentElement)m();else addEventListener('DOMContentLoaded',m);})();
    """

    /// Title-bar behaviour the page cannot get from WebKit alone:
    ///   - drag: a primary mousedown on one of the client's drag regions (the
    ///     sidebar top strip, the conversation title row — the elements the
    ///     shipped CSS marks `-webkit-app-region: drag`, which WKWebView ignores)
    ///     that is not on a control is reported with its click count; the
    ///     wrapper moves the window or applies the title-bar double-click action;
    ///   - theme: `html[data-ds-theme-source]` (light | dark | system, written by
    ///     the client's theme presenter) is reported on load and on change so the
    ///     window appearance, hence the vibrancy material, follows the page.
    /// The class selectors match the `<hash>_<local>` names CSS modules compile
    /// to; the 60px band keeps a same-named class elsewhere from dragging.
    static let titlebarBridgeScript = """
    (() => {
      const post = body => { try { webkit.messageHandlers.dshDock.postMessage(body) } catch {} };
      const control = 'button,a,input,textarea,select,summary,label,[role="button"],[role="menuitem"],[role="tab"],[role="slider"],[role="switch"],[role="checkbox"],[role="combobox"],[contenteditable]';
      const region = '[class*="_topStrip"],[class*="_titleRow"]';
      addEventListener('mousedown', e => {
        if (e.button !== 0 || e.buttons !== 1 || e.clientY > 60) return;
        const target = e.target instanceof Element ? e.target : null;
        if (!target || target.closest(control) || !target.closest(region)) return;
        post({ type: 'titlebar', clicks: e.detail });
      }, true);
      let sent;
      const theme = () => {
        const value = document.documentElement.getAttribute('data-ds-theme-source');
        if (value !== null && value !== sent) { sent = value; post({ type: 'theme', value }) }
      };
      const observe = () => { new MutationObserver(theme).observe(document.documentElement, { attributeFilter: ['data-ds-theme-source'] }); theme() };
      if (document.readyState === 'loading') addEventListener('DOMContentLoaded', observe); else observe();
    })();
    """

    // MARK: integrated title bar

    /// Where the close button's frame sits, from the window's top-left — the
    /// upstream Electron shell's `trafficLightPosition: { x: 16, y: 18 }`, which
    /// the client's 52px sidebar top strip is drawn for (16 + 16 + 2·18 = 52).
    static let trafficLightOrigin = NSPoint(x: 16, y: 18)
    /// Stock distance between neighbouring buttons' origins, read once before the first move.
    private var trafficLightSpacing: CGFloat?
    /// Rollover tracking over the moved group (see DockWindow); replaced on every layout.
    private var trafficLightTracking: NSTrackingArea?

    /// Move the traffic lights to `trafficLightOrigin` and grow the title-bar
    /// container to hold them (AppKit lays them out for a 28px bar; a button
    /// outside its container's bounds is not hit-testable). Re-run on every
    /// resize and on leaving full screen, when AppKit rebuilds the bar.
    func layoutTrafficLights() {
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { window.standardWindowButton($0) }
        guard buttons.count == 3, let titlebar = buttons[0].superview, let container = titlebar.superview, let frame = container.superview else { return }
        if trafficLightSpacing == nil { trafficLightSpacing = buttons[1].frame.minX - buttons[0].frame.minX }
        let spacing = trafficLightSpacing ?? 20
        let margin = Self.trafficLightOrigin
        let height = margin.y * 2 + buttons[0].frame.height
        var containerFrame = container.frame
        containerFrame.size.height = height
        containerFrame.origin.y = frame.bounds.height - height
        if container.frame != containerFrame { container.frame = containerFrame }
        if titlebar.frame != container.bounds { titlebar.frame = container.bounds }
        var group = NSRect.null
        for (index, button) in buttons.enumerated() {
            var buttonFrame = button.frame
            buttonFrame.origin = NSPoint(x: margin.x + CGFloat(index) * spacing, y: margin.y)
            if button.frame != buttonFrame { button.frame = buttonFrame }
            group = group.union(buttonFrame)
        }
        if let old = trafficLightTracking, old.rect == group, titlebar.trackingAreas.contains(old) { return }
        if let old = trafficLightTracking { titlebar.removeTrackingArea(old) }
        let tracking = NSTrackingArea(rect: group, options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil)
        titlebar.addTrackingArea(tracking)
        trafficLightTracking = tracking
    }

    private func setPointerOverTrafficLights(_ inside: Bool) {
        guard window.pointerOverTrafficLights != inside else { return }
        window.pointerOverTrafficLights = inside
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(type)?.needsDisplay = true }
    }

    // Tracking-area owner callbacks (the delegate is not a responder; these are plain selectors).
    @objc func mouseEntered(with event: NSEvent) {
        if event.trackingArea === trafficLightTracking { setPointerOverTrafficLights(true) }
    }

    @objc func mouseExited(with event: NSEvent) {
        if event.trackingArea === trafficLightTracking { setPointerOverTrafficLights(false) }
    }

    func windowDidResize(_ notification: Notification) { layoutTrafficLights() }
    func windowDidExitFullScreen(_ notification: Notification) { layoutTrafficLights() }
    func windowDidBecomeKey(_ notification: Notification) { layoutTrafficLights() }

    /// A mousedown on a page drag region. One click drags the window; a double
    /// click applies the System Settings ▸ Desktop & Dock ▸ "Double-click a
    /// window's title bar to" action (Zoom by default).
    func titlebarMouseDown(clicks: Int) {
        if clicks >= 2 {
            let action = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?["AppleActionOnDoubleClick"] as? String
            switch action {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
            return
        }
        // The message arrives after the event; the drag is still in progress (or the
        // button is already up, in which case AppKit ends the drag at once).
        guard let event = NSApp.currentEvent, event.type == .leftMouseDown || event.type == .leftMouseDragged else { return }
        window.performDrag(with: event)
    }

    /// `html[data-ds-theme-source]` → window appearance, so the sidebar vibrancy
    /// material and the traffic lights follow the page's theme; `system` (or
    /// anything else) follows the OS.
    func applyPageTheme(_ value: String) {
        switch value {
        case "dark": window.appearance = NSAppearance(named: .darkAqua)
        case "light": window.appearance = NSAppearance(named: .aqua)
        default: window.appearance = nil
        }
    }

    // MARK: window snapshot (View ▸ Save Window Snapshot, or `kill -USR1 <pid>`)

    private var snapshotSignal: DispatchSourceSignal?
    private var terminateSignal: DispatchSourceSignal?

    /// `kill <pid>` (SIGTERM) quits like ⌘Q so applicationWillTerminate runs and
    /// an embedded server is stopped with the window instead of being orphaned.
    func installTerminateSignal() {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }
        source.resume()
        terminateSignal = source
    }

    /// `kill -USR1 <pid>` saves a PNG of the window — the way an agent without
    /// Screen Recording or Accessibility permission sees what the wrapper
    /// draws (a process may capture its own windows without either).
    func installSnapshotSignal() {
        signal(SIGUSR1, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        source.setEventHandler { [weak self] in self?.saveWindowSnapshot() }
        source.resume()
        snapshotSignal = source
    }

    /// Write the main window (title bar included) to ~/Library/Logs/DSH Dock/<app>-<unix time>.png and log the path.
    @objc func saveWindowSnapshot() {
        guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]),
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            appendLog("snapshot: capture failed")
            return
        }
        let url = logURL.deletingLastPathComponent().appendingPathComponent("\(config.name)-\(Int(Date().timeIntervalSince1970)).png")
        do {
            try png.write(to: url)
            appendLog("snapshot: \(url.path)")
        } catch {
            appendLog("snapshot: \(error)")
        }
    }

    // MARK: window material (View ▸ Window Material)

    /// Build the window's content: the material and the page over it. The
    /// frosted material is the standard translucent sidebar vibrancy (Finder's;
    /// Electron's `vibrancy: 'sidebar'`) blurring the desktop behind the
    /// window; the Liquid Glass variant (macOS 26+) adds an `NSGlassEffectView`
    /// between that blur and the page. Re-run when the choice changes.
    func installBackdrop() {
        let bounds = window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1280, height: 860)
        let backdrop = NSVisualEffectView(frame: bounds)
        backdrop.material = .sidebar
        backdrop.blendingMode = .behindWindow
        // 'active' keeps the material stable when the window blurs (Electron's `visualEffectState: 'active'`).
        backdrop.state = .active
        webView.removeFromSuperview()
        webView.frame = backdrop.bounds
        if #available(macOS 26.0, *), windowMaterial == .liquidGlass {
            let glass = NSGlassEffectView(frame: backdrop.bounds)
            glass.autoresizingMask = [.width, .height]
            glass.style = .clear
            glass.contentView = webView
            backdrop.addSubview(glass)
        } else {
            backdrop.addSubview(webView)
        }
        window.contentView = backdrop
        syncWindowMaterialMenu()
    }

    @objc func selectFrostedMaterial() { setWindowMaterial(.frosted) }
    @objc func selectLiquidGlassMaterial() { setWindowMaterial(.liquidGlass) }

    func setWindowMaterial(_ material: WindowMaterial) {
        guard material != windowMaterial else { return }
        windowMaterial = material
        WindowMaterial.stored = material
        installBackdrop()
        appendLog("window material: \(material.rawValue)")
    }

    func syncWindowMaterialMenu() {
        frostedMenuItem?.state = windowMaterial == .frosted ? .on : .off
        liquidGlassMenuItem?.state = windowMaterial == .liquidGlass ? .on : .off
        if #available(macOS 26.0, *) {} else { liquidGlassMenuItem?.isEnabled = false }
    }

    // MARK: view mode (View ▸ Desktop / Mobile)

    @objc func selectDesktopView() { setViewMode(.desktop) }
    @objc func selectMobileView() { setViewMode(.mobile) }

    func setViewMode(_ mode: ViewMode) {
        guard mode != viewMode else { return }
        let previous = viewMode
        viewMode = mode
        ViewMode.stored = mode
        // Next load: the document-start script carries the new flag. This load: flip it live.
        installUserScripts(into: webView.configuration.userContentController)
        webView.evaluateJavaScript(mode.script, completionHandler: nil)
        switch (previous, mode) {
        case (.desktop, .mobile):
            UserDefaults.standard.set(NSStringFromRect(window.frame), forKey: ViewMode.desktopFrameKey)
            resizeContentKeepingTopLeft(to: ViewMode.mobileContentSize)
        case (.mobile, .desktop):
            if let saved = UserDefaults.standard.string(forKey: ViewMode.desktopFrameKey) {
                window.setFrame(NSRectFromString(saved), display: true, animate: true)
            } else {
                resizeContentKeepingTopLeft(to: NSSize(width: 1280, height: 860))
            }
        default:
            break
        }
        syncViewModeMenu()
        appendLog("view mode: \(mode.rawValue)")
    }

    /// Resize the content area, keeping the window's top-left corner where it is (clamped to the screen).
    func resizeContentKeepingTopLeft(to size: NSSize) {
        let contentRect = NSRect(origin: .zero, size: size)
        var frame = window.frameRect(forContentRect: contentRect)
        frame.origin = NSPoint(x: window.frame.minX, y: window.frame.maxY - frame.height)
        if let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
            if frame.height > visible.height { frame.size.height = visible.height }
            frame.origin.y = max(visible.minY, min(frame.origin.y, visible.maxY - frame.height))
            frame.origin.x = max(visible.minX, min(frame.origin.x, visible.maxX - frame.width))
        }
        window.setFrame(frame, display: true, animate: true)
    }

    func syncViewModeMenu() {
        desktopMenuItem?.state = viewMode == .desktop ? .on : .off
        mobileMenuItem?.state = viewMode == .mobile ? .on : .off
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        forwarder.closeAll()
        embedded?.stop()
    }

    /// The DSH mount the page is loaded from right now (tailnet or loopback fallback), or nil while offline.
    func currentMountBase() -> URL? {
        if showingOfflinePage { return nil }
        if let current = webView.url, let base = scope.mountBase(for: current) { return base }
        return scope.mountBase(for: remoteURL)
    }

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
        retryTimer?.invalidate()
        if let server = embedded {
            // Embedded: a retry restarts the server when it is down; while it runs, its announcement drives the load.
            if server.process?.isRunning != true {
                embeddedRestarts += 1
                appendLog("embedded: restart #\(embeddedRestarts) requested")
                server.start()
            } else if let url = embeddedURL {
                showingOfflinePage = false
                webView.load(URLRequest(url: url))
            }
            return
        }
        connecting = true
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

    func showOffline(reason: String, autoRetry: Bool = true) {
        showingOfflinePage = true
        let footer = autoRetry ? "<p style=\"font-size:.9em\">Retrying automatically every 5 seconds.</p>" : ""
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><title>\(config.name)</title>
        <style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#fafafa;color:#222}
        @media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#e5e5e7}}main{max-width:34em;padding:2em;text-align:center}h1{font-size:1.25em;font-weight:600}
        p{color:#666}@media (prefers-color-scheme:dark){p{color:#a1a1a6}}code{font:.92em ui-monospace,Menlo,monospace}
        button{font:inherit;padding:.4em 1.1em;border-radius:8px;border:1px solid #8884;background:#3b82f6;color:#fff;cursor:pointer}</style></head>
        <body><main><h1>DSH is unreachable</h1><p>\(reason)</p><p><code>\(config.url)</code></p>
        <p><button onclick="webkit.messageHandlers.dshDock.postMessage('retry')">Try again</button></p>
        \(footer)</main></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
        retryTimer?.invalidate()
        if autoRetry {
            retryTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in self?.connect() }
        }
    }

    private lazy var logURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/DSH Dock", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // The bundled app logs beside, not into, a checkout-installed wrapper of the same name.
        return dir.appendingPathComponent(config.embedded == nil ? "\(config.name).log" : "\(config.name) (bundled).log")
    }()
    private let logStamp: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"; return f }()
    func appendLog(_ line: String) {
        let text = "\(logStamp.string(from: Date())) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: logURL) { defer { try? handle.close() }; try? handle.seekToEnd(); handle.write(Data(text.utf8)) }
        else { try? text.write(to: logURL, atomically: true, encoding: .utf8) }
    }

    /// One-shot hint for the next file picker, posted by the page just before it
    /// opens an <input type=file> (`webkit.messageHandlers.dshDock.postMessage(
    /// {type: "open-panel", directory: "~/.pi/agent", message: "…", showsHiddenFiles: true})`).
    /// A web page cannot choose where a picker starts; the wrapper can. Consumed
    /// by the next runOpenPanel or dropped after 10 s.
    private var openPanelHint: (directory: URL?, message: String?, showsHiddenFiles: Bool, expires: Date)?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "dshDock" else { return }
        if (message.body as? String) == "retry" { connect(); return }
        guard let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "console" {
            appendLog("[\(body["level"] as? String ?? "log")] \(body["text"] as? String ?? "")")
            return
        }
        // Popup windows share the user scripts; only the main page steers the main window.
        if body["type"] as? String == "titlebar" {
            if message.webView === webView { titlebarMouseDown(clicks: body["clicks"] as? Int ?? 1) }
            return
        }
        if body["type"] as? String == "theme" {
            if message.webView === webView { applyPageTheme(body["value"] as? String ?? "system") }
            return
        }
        guard body["type"] as? String == "open-panel" else { return }
        var directory: URL?
        // `file` wins when it exists: NSOpenPanel opens the containing folder with
        // that file selected when directoryURL names a file (long-standing AppKit
        // behaviour, not documented — hence the directory fallback).
        if let raw = body["file"] as? String, !raw.isEmpty {
            let expanded = NSString(string: raw).expandingTildeInPath
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: expanded, isDirectory: &isDir), !isDir.boolValue { directory = URL(fileURLWithPath: expanded) }
        }
        if directory == nil, let raw = body["directory"] as? String, !raw.isEmpty {
            let expanded = NSString(string: raw).expandingTildeInPath
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: expanded, isDirectory: &isDir), isDir.boolValue { directory = URL(fileURLWithPath: expanded) }
        }
        openPanelHint = (directory, body["message"] as? String, body["showsHiddenFiles"] as? Bool ?? false, Date().addingTimeInterval(10))
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { decisionHandler(.allow); return }
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        // A loopback URL outside our own entry points names the remote's loopback:
        // forward the port first, then let the load proceed (an iframe such as the
        // GUI's Sidebar Browser) or hand a top-level navigation to the default
        // browser like any other foreign link — the tunnel stays up either way.
        if !scope.contains(url), let link = LoopbackLink(url) {
            forwardLoopback(link) { [weak self] target in
                guard let self else { decisionHandler(.cancel); return }
                guard let target else { decisionHandler(.cancel); return }
                if self.scope.contains(target) {
                    // The remote's own DSH port → this app: main frame loads it here, a subframe gets a window.
                    if isMainFrame { webView.load(URLRequest(url: target)) } else { self.openPopupWindow(target) }
                    decisionHandler(.cancel)
                } else if isMainFrame {
                    NSWorkspace.shared.open(target)
                    decisionHandler(.cancel)
                } else if target == url {
                    decisionHandler(.allow)
                } else {
                    // The subframe cannot be redirected onto the substitute local port; open it outside.
                    NSWorkspace.shared.open(target)
                    decisionHandler(.cancel)
                }
            }
            return
        }
        // Only user-initiated top-level navigations are subject to the scope rule;
        // redirects and in-scope loads (including the token exchange) pass.
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

    /// Secondary windows opened by the page (window.open / target=_blank on an in-scope URL, e.g. a
    /// an inline plot image at full size). Each is its own WKWebView sharing this app's data store
    /// (cookies), so the request is admitted like the main page. Kept alive here; removed on close.
    private var popups: [NSWindow] = []

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        // A loopback URL (target=_blank link, "Open in system browser" from the GUI's
        // Browser tab): forward the port, then open it in the default browser — the
        // user's real browser is the better host for a dev server than a wrapper window.
        if !scope.contains(url), let link = LoopbackLink(url) {
            forwardLoopback(link) { [weak self] target in
                guard let self, let target else { return }
                if self.scope.contains(target) { self.openPopupWindow(target) } else { NSWorkspace.shared.open(target) }
            }
            return nil
        }
        // Out of scope → the default browser, as before.
        guard scope.contains(url) else { NSWorkspace.shared.open(url); return nil }
        // In scope → a real second window. (Until 2026-09-22 this loaded the URL into the MAIN
        // window: clicking an inline image replaced the whole GUI with the bare image, and
        // the red button then closed the app's only window.) WebKit requires the returned view to
        // be created with the configuration it hands us.
        return makePopup(configuration: configuration, title: url.lastPathComponent)
    }

    /// A second window of ours for an in-scope URL we choose to load (not a page-initiated popup).
    private func openPopupWindow(_ url: URL) {
        let popup = makePopup(configuration: webView.configuration.copy() as! WKWebViewConfiguration, title: url.lastPathComponent)
        popup.load(URLRequest(url: url))
    }

    private func makePopup(configuration: WKWebViewConfiguration, title: String) -> WKWebView {
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = title.isEmpty ? config.name : title
        w.contentView = popup
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.center()
        if let main = window { w.setFrameOrigin(NSPoint(x: main.frame.midX - 480, y: main.frame.midY - 360)) }
        popups.append(w)
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { [weak self] _ in
            self?.popups.removeAll { $0 === w }
        }
        w.makeKeyAndOrderFront(nil)
        return popup
    }

    // MARK: loopback forwarding

    /// Forward the remote port a loopback link names, then call back with the URL to
    /// use here: the link itself when the same local port could be bound, a rewritten
    /// one when it could not, this app's own mount when the port is the remote DSH
    /// instance itself, or nil when the remote refused (an alert says why).
    func forwardLoopback(_ link: LoopbackLink, completion: @escaping (URL?) -> Void) {
        forwarder.ensure(remotePort: link.port) { [weak self] result in
            guard let self else { completion(nil); return }
            switch result {
            case .success(let listener):
                completion(link.rewritten(toLocalPort: listener.localPort))
            case .failure(let error):
                if error.refusalCode == "reserved", let base = self.currentMountBase() {
                    // `$DSH_WEB_URL`-style links (http://127.0.0.1:<dsh port>/...) mean this very GUI.
                    var relative = link.url.path.isEmpty ? "" : String(link.url.path.dropFirst())
                    if let query = link.url.query { relative += "?\(query)" }
                    completion(URL(string: relative, relativeTo: base)?.absoluteURL ?? base)
                    return
                }
                self.reportForwardFailure(port: link.port, error: error)
                completion(nil)
            }
        }
    }

    private func reportForwardFailure(port: Int, error: ForwardError) {
        appendLog("forward: \(port): \(error)")
        let now = Date()
        if let last = lastForwardAlert[port], now.timeIntervalSince(last) < 30 { return }
        lastForwardAlert[port] = now
        let alert = NSAlert()
        alert.messageText = "Cannot open 127.0.0.1:\(port) on the DSH host"
        alert.informativeText = "\(error)"
        alert.addButton(withTitle: "OK")
        if let window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    @objc func closeForward(_ sender: NSMenuItem) {
        guard let port = sender.representedObject as? Int else { return }
        forwarder.close(remotePort: port)
    }

    @objc func closeAllForwards() { forwarder.closeAll() }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === forwardedPortsMenu else { return }
        menu.removeAllItems()
        let rows = forwarder.rows
        if rows.isEmpty {
            let none = menu.addItem(withTitle: "No forwarded ports", action: nil, keyEquivalent: "")
            none.isEnabled = false
            return
        }
        for row in rows {
            let label = row.localPort == row.remotePort
                ? "127.0.0.1:\(row.remotePort)"
                : "127.0.0.1:\(row.localPort) → remote :\(row.remotePort)"
            let suffix = row.connections == 0 ? "" : "  (\(row.connections) connection\(row.connections == 1 ? "" : "s"))"
            let item = menu.addItem(withTitle: "Close \(label)\(suffix)", action: #selector(closeForward(_:)), keyEquivalent: "")
            item.representedObject = row.remotePort
            item.target = self
        }
        menu.addItem(.separator())
        let all = menu.addItem(withTitle: "Close All", action: #selector(closeAllForwards), keyEquivalent: "")
        all.target = self
    }

    /// `window.close()` from a popup page.
    func webViewDidClose(_ webView: WKWebView) {
        if let w = popups.first(where: { $0.contentView === webView }) { w.close() }
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
        if let hint = openPanelHint, hint.expires > Date() {
            if let directory = hint.directory { panel.directoryURL = directory }
            if let text = hint.message { panel.message = text }
            panel.showsHiddenFiles = hint.showsHiddenFiles
        }
        openPanelHint = nil
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

    /// Toggle the GUI's Settings panel from the page side. Two layers:
    ///  1. the tali-settings-shortcut plugin, when loaded, owns the toggle — dispatch its ⌘. chord as a
    ///     synthetic `keydown` on `window` (its capture listener `preventDefault`s → dispatchEvent returns false);
    ///  2. otherwise click the sidebar's Settings trigger, or the open panel's close button (the shell keeps
    ///     the open state as component-local React state; the DOM is the only seam — same selectors as the
    ///     plugin, `[hash]_[local]` CSS-module classes make the `_suffix` stable across rebuilds).
    static let toggleSettingsScript = """
    (() => {
      const chord = new KeyboardEvent('keydown', { key: '.', code: 'Period', metaKey: true, bubbles: true, cancelable: true });
      if (!window.dispatchEvent(chord)) return 'plugin';
      const trigger = document.querySelector('[class$="_settingsArea"] button[aria-haspopup="dialog"]')
        || document.querySelector('button[aria-haspopup="dialog"][class*="_trigger"]');
      if (!trigger) return 'no-trigger';
      if (trigger.getAttribute('aria-expanded') === 'true') {
        const close = document.querySelector('[role="dialog"][class$="_panel"] button[class$="_close"]');
        if (!close) return 'no-close';
        close.click();
        return 'closed';
      }
      trigger.click();
      return 'opened';
    })()
    """

    @objc func openSettings() {
        if showingOfflinePage { NSSound.beep(); return }
        window.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript(AppDelegate.toggleSettingsScript) { [weak self] result, error in
            let outcome = (result as? String) ?? (error.map { "error: \($0.localizedDescription)" } ?? "unknown")
            self?.appendLog("settings: \(outcome)")
            if outcome == "no-trigger" || outcome == "no-close" { NSSound.beep() }
        }
    }

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
            .credits: NSAttributedString(string: config.embedded == nil
                ? "Thin WKWebView wrapper for the DSH Web GUI.\n\(config.url)"
                : "Self-contained DSH: \(releaseSummary())"),
        ])
    }

    /// `dsh-app-release.json` written by build-app.mjs, as one line for the About panel.
    func releaseSummary() -> String {
        guard let url = Bundle.main.url(forResource: "dsh-app-release", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "(no release manifest)" }
        let plugins = (json["plugins"] as? [[String: Any]])?.count ?? 0
        return "build \(json["build"] ?? "?") · dsh \(json["dsh"] ?? "?") · node \(json["node"] ?? "?") · \(plugins) plugins"
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "About \(config.name)", action: #selector(showAbout), keyEquivalent: "")
        if config.update != nil {
            app.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
        }
        app.addItem(.separator())
        // The standard macOS chord. Safari cannot give ⌘, to a page (it is Safari's own Settings…);
        // here the menu bar is ours, so it drives the GUI's Settings panel instead.
        app.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
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
        desktopMenuItem = view.addItem(withTitle: "Desktop", action: #selector(selectDesktopView), keyEquivalent: "")
        mobileMenuItem = view.addItem(withTitle: "Mobile", action: #selector(selectMobileView), keyEquivalent: "")
        syncViewModeMenu()
        view.addItem(.separator())
        let materialItem = view.addItem(withTitle: "Window Material", action: nil, keyEquivalent: "")
        let material = NSMenu(title: "Window Material")
        material.autoenablesItems = false
        frostedMenuItem = material.addItem(withTitle: "Frosted", action: #selector(selectFrostedMaterial), keyEquivalent: "")
        frostedMenuItem.target = self
        liquidGlassMenuItem = material.addItem(withTitle: "Liquid Glass", action: #selector(selectLiquidGlassMaterial), keyEquivalent: "")
        liquidGlassMenuItem.target = self
        materialItem.submenu = material
        syncWindowMaterialMenu()
        view.addItem(.separator())
        let openInBrowser = view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o")
        openInBrowser.keyEquivalentModifierMask = [.command, .shift]
        let copy = view.addItem(withTitle: "Copy Address", action: #selector(copyURL), keyEquivalent: "c")
        copy.keyEquivalentModifierMask = [.command, .shift]
        view.addItem(.separator())
        let forwards = view.addItem(withTitle: "Forwarded Ports", action: nil, keyEquivalent: "")
        forwardedPortsMenu.delegate = self
        forwardedPortsMenu.autoenablesItems = false
        forwards.submenu = forwardedPortsMenu
        view.addItem(withTitle: "Save Window Snapshot", action: #selector(saveWindowSnapshot), keyEquivalent: "")
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
