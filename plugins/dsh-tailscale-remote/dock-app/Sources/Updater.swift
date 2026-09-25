// In-app updates for the bundled app (DSH Canary) from GitHub Releases —
// hand-rolled rather than Sparkle: no framework, no appcast, no signing
// requirement (the app is ad-hoc signed; a bundle the app itself downloads
// carries no quarantine flag, so the swap launches without Gatekeeper).
//
// Configured by the `update` block of dsh-dock-app.json:
//   "update": { "repo": "taliesinb/dsh-plugins", "intervalHours": 6,
//               "feed": null }          // feed overrides the GitHub URL (testing)
//
// Protocol (produced by tools/bundle/release.mjs):
//   GET https://api.github.com/repos/<repo>/releases/latest  → JSON with
//     tag_name  "canary-<build>"   build = integer, compared with CFBundleVersion
//     name      "DSH Canary 2026.9.24"
//     body      release notes (shown in the prompt)
//     assets[]  one *.dmg and its sibling *.dmg.sha256 (hex digest, first word)
// Install: download the DMG to a temp dir (progress window), verify sha256,
// `hdiutil attach -nobrowse -readonly`, copy `<Name>.app` beside the running
// bundle, move the running bundle to the Trash, rename the copy into place,
// detach, `open` the new bundle and terminate (which stops the embedded
// server). Refused when the app runs translocated (from a DMG) or from a
// directory it cannot write — then the user is told to move it to Applications.
// A version can be skipped (UserDefaults `dsh.update.skipBuild`).

import Cocoa
import CryptoKit

struct UpdateSpec: Decodable {
    var repo: String
    var intervalHours: Double?
    var feed: String?
}

struct ReleaseInfo {
    let build: Int
    let name: String
    let notes: String
    let dmgURL: URL
    let shaURL: URL?
    let dmgSize: Int
}

enum UpdateError: LocalizedError {
    case badFeed(String), noAsset, checksum, mount(String), translocated, unwritable(String), copy(String)
    var errorDescription: String? {
        switch self {
        case .badFeed(let why): return "The release feed could not be read: \(why)"
        case .noAsset: return "The latest release carries no .dmg asset."
        case .checksum: return "The downloaded image does not match its published SHA-256; not installing it."
        case .mount(let why): return "The disk image could not be mounted: \(why)"
        case .translocated: return "This copy runs from a disk image (or is translocated). Move it to Applications, launch it from there, then update."
        case .unwritable(let dir): return "The app's folder (\(dir)) is not writable, so it cannot be replaced. Move the app to your Applications folder."
        case .copy(let why): return "Installing the new version failed: \(why)"
        }
    }
}

final class Updater: NSObject {
    let spec: UpdateSpec
    let appName: String
    let log: (String) -> Void
    private var timer: Timer?
    private var busy = false
    private var progressWindow: NSWindow?
    private var progressBar: NSProgressIndicator?
    private var progressLabel: NSTextField?
    private var session: URLSession?
    private static let skipKey = "dsh.update.skipBuild"
    /// `defaults write <bundle id> dsh.update.autoInstall -bool true`: install without the prompt (headless testing).
    private static let autoInstallKey = "dsh.update.autoInstall"

    init(spec: UpdateSpec, appName: String, log: @escaping (String) -> Void) {
        self.spec = spec
        self.appName = appName
        self.log = log
    }

    /// CFBundleVersion as an integer build number (0 when unset — a dev build always sees updates).
    var currentBuild: Int { Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") ?? 0 }
    var currentVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }

    var feedURL: URL {
        if let feed = spec.feed, let url = URL(string: feed) { return url }
        return URL(string: "https://api.github.com/repos/\(spec.repo)/releases/latest")!
    }

    /// Start the periodic check: first one after `delay`, then every intervalHours.
    func schedule(delay: TimeInterval = 10) {
        let hours = spec.intervalHours ?? 6
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.check(userInitiated: false) }
        timer = Timer.scheduledTimer(withTimeInterval: max(hours, 0.25) * 3600, repeats: true) { [weak self] _ in self?.check(userInitiated: false) }
    }

    // MARK: check

    @objc func checkNow() { check(userInitiated: true) }

    func check(userInitiated: Bool) {
        guard !busy else { return }
        var request = URLRequest(url: feedURL)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("dsh-canary-updater/\(currentBuild)", forHTTPHeaderField: "User-Agent")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                do {
                    if let error { throw UpdateError.badFeed(error.localizedDescription) }
                    guard let http = response as? HTTPURLResponse, let data else { throw UpdateError.badFeed("no response") }
                    guard http.statusCode == 200 else { throw UpdateError.badFeed("HTTP \(http.statusCode)") }
                    let info = try Updater.parse(data)
                    self.log("update: latest build \(info.build) (\(info.name)); running \(self.currentBuild)")
                    if info.build > self.currentBuild {
                        let skipped = UserDefaults.standard.integer(forKey: Updater.skipKey)
                        if !userInitiated && skipped == info.build { return }
                        self.offer(info)
                    } else if userInitiated {
                        let alert = NSAlert()
                        alert.messageText = "\(self.appName) is up to date"
                        alert.informativeText = "Version \(self.currentVersion) (build \(self.currentBuild)) is the latest release."
                        alert.runModal()
                    }
                } catch {
                    self.log("update: check failed: \(error.localizedDescription)")
                    if userInitiated { self.fail(error) }
                }
            }
        }.resume()
    }

    static func parse(_ data: Data) throws -> ReleaseInfo {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw UpdateError.badFeed("not a JSON object") }
        guard let tag = json["tag_name"] as? String else { throw UpdateError.badFeed("no tag_name") }
        guard let build = Int(tag.split(separator: "-").last ?? "") else { throw UpdateError.badFeed("tag '\(tag)' carries no build number") }
        let assets = json["assets"] as? [[String: Any]] ?? []
        guard let dmg = assets.first(where: { ($0["name"] as? String)?.hasSuffix(".dmg") == true }),
              let dmgURL = (dmg["browser_download_url"] as? String).flatMap(URL.init(string:)) else { throw UpdateError.noAsset }
        let dmgName = dmg["name"] as? String ?? ""
        let sha = assets.first(where: { ($0["name"] as? String) == dmgName + ".sha256" })
        let shaURL = (sha?["browser_download_url"] as? String).flatMap(URL.init(string:))
        return ReleaseInfo(build: build, name: json["name"] as? String ?? tag, notes: json["body"] as? String ?? "",
                           dmgURL: dmgURL, shaURL: shaURL, dmgSize: dmg["size"] as? Int ?? 0)
    }

    // MARK: offer

    private func offer(_ info: ReleaseInfo) {
        if UserDefaults.standard.bool(forKey: Updater.autoInstallKey) {
            log("update: autoInstall set; installing build \(info.build) without prompting")
            install(info)
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "\(info.name) is available"
        var detail = "You have \(currentVersion) (build \(currentBuild))."
        if info.dmgSize > 0 { detail += " The download is \(ByteCountFormatter.string(fromByteCount: Int64(info.dmgSize), countStyle: .file))." }
        let notes = info.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if !notes.isEmpty { detail += "\n\n" + String(notes.prefix(1200)) }
        alert.informativeText = detail
        alert.addButton(withTitle: "Install and Relaunch")
        alert.addButton(withTitle: "Later")
        alert.addButton(withTitle: "Skip This Version")
        switch alert.runModal() {
        case .alertFirstButtonReturn: install(info)
        case .alertThirdButtonReturn: UserDefaults.standard.set(info.build, forKey: Updater.skipKey)
        default: break
        }
    }

    // MARK: install

    private func install(_ info: ReleaseInfo) {
        do { try preflight() } catch { fail(error); return }
        busy = true
        showProgress("Downloading \(info.name)…")
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-update-\(info.build)", isDirectory: true)
        try? FileManager.default.removeItem(at: staging)
        try? FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let dmgPath = staging.appendingPathComponent(info.dmgURL.lastPathComponent)

        fetchText(info.shaURL) { [weak self] expectedSha in
            guard let self else { return }
            let delegate = DownloadDelegate(progress: { [weak self] fraction in
                self?.progressBar?.doubleValue = fraction * 100
            }, finished: { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch result {
                    case .failure(let error):
                        self.finish(error: error)
                    case .success(let tmp):
                        do {
                            try? FileManager.default.removeItem(at: dmgPath)
                            try FileManager.default.moveItem(at: tmp, to: dmgPath)
                            self.progressLabel?.stringValue = "Verifying…"
                            try self.verify(dmgPath, expectedSha: expectedSha)
                            self.progressLabel?.stringValue = "Installing…"
                            self.progressBar?.isIndeterminate = true
                            self.progressBar?.startAnimation(nil)
                            DispatchQueue.global(qos: .userInitiated).async {
                                let outcome = Result { try self.swap(dmg: dmgPath, staging: staging) }
                                DispatchQueue.main.async {
                                    switch outcome {
                                    case .success(let newApp): self.relaunch(newApp)
                                    case .failure(let error): self.finish(error: error)
                                    }
                                }
                            }
                        } catch {
                            self.finish(error: error)
                        }
                    }
                }
            })
            let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
            self.session = session
            session.downloadTask(with: info.dmgURL).resume()
        }
    }

    private func preflight() throws {
        let bundle = Bundle.main.bundleURL
        if bundle.path.contains("/AppTranslocation/") || bundle.path.hasPrefix("/Volumes/") { throw UpdateError.translocated }
        let parent = bundle.deletingLastPathComponent()
        if !FileManager.default.isWritableFile(atPath: parent.path) { throw UpdateError.unwritable(parent.path) }
    }

    private func fetchText(_ url: URL?, completion: @escaping (String?) -> Void) {
        guard let url else { completion(nil); return }
        var request = URLRequest(url: url)
        request.setValue("dsh-canary-updater/\(currentBuild)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let text = data.flatMap { String(data: $0, encoding: .utf8) }
            DispatchQueue.main.async { completion(text) }
        }.resume()
    }

    private func verify(_ dmg: URL, expectedSha: String?) throws {
        guard let expectedSha else {
            log("update: no .sha256 asset published; installing unverified")
            return
        }
        let expected = expectedSha.split(whereSeparator: { $0 == " " || $0 == "\n" }).first.map(String.init)?.lowercased() ?? ""
        let data = try Data(contentsOf: dmg, options: .mappedIfSafe)
        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard actual == expected else {
            log("update: sha256 mismatch expected \(expected) got \(actual)")
            throw UpdateError.checksum
        }
    }

    /// Mount, copy the new bundle beside ours, Trash ours, rename the copy into place, detach. Returns the installed bundle URL.
    private func swap(dmg: URL, staging: URL) throws -> URL {
        let mount = staging.appendingPathComponent("mount", isDirectory: true)
        let attach = run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint", mount.path, dmg.path])
        guard attach.status == 0 else { throw UpdateError.mount(attach.output) }
        defer { _ = run("/usr/bin/hdiutil", ["detach", mount.path, "-quiet"]) }
        let fm = FileManager.default
        guard let appInImage = (try? fm.contentsOfDirectory(at: mount, includingPropertiesForKeys: nil))?.first(where: { $0.pathExtension == "app" }) else {
            throw UpdateError.copy("the image contains no .app")
        }
        let current = Bundle.main.bundleURL
        let parent = current.deletingLastPathComponent()
        let incoming = parent.appendingPathComponent(".\(current.lastPathComponent).update-\(UUID().uuidString.prefix(8))")
        // `cp -R` keeps the ad-hoc signature intact (attributes, symlinks) where FileManager.copyItem has surprised before.
        let copy = run("/bin/cp", ["-R", appInImage.path, incoming.path])
        guard copy.status == 0 else { throw UpdateError.copy(copy.output) }
        let verify = run("/usr/bin/codesign", ["--verify", "--deep", incoming.path])
        guard verify.status == 0 else { try? fm.removeItem(at: incoming); throw UpdateError.copy("the copied bundle fails codesign --verify: \(verify.output)") }
        do {
            try fm.trashItem(at: current, resultingItemURL: nil)
        } catch {
            // Trash unavailable (network volume, odd permissions): rename aside instead.
            let aside = parent.appendingPathComponent("\(current.deletingPathExtension().lastPathComponent) (old).app")
            try? fm.removeItem(at: aside)
            try fm.moveItem(at: current, to: aside)
        }
        try fm.moveItem(at: incoming, to: current)
        return current
    }

    private func relaunch(_ app: URL) {
        log("update: installed \(app.path); relaunching")
        progressLabel?.stringValue = "Relaunching…"
        // `open` after this process has exited, so LSMultipleInstancesProhibited does not refuse the new copy.
        let script = "while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.2; done; /usr/bin/open \"\(app.path)\""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script]
        try? p.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
    }

    private func finish(error: Error) {
        busy = false
        session?.invalidateAndCancel()
        session = nil
        progressWindow?.close()
        progressWindow = nil
        log("update: failed: \(error.localizedDescription)")
        fail(error)
    }

    private func fail(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Update failed"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    // MARK: progress window

    private func showProgress(_ title: String) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 96), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Updating \(appName)"
        window.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: title)
        label.frame = NSRect(x: 20, y: 56, width: 380, height: 20)
        let bar = NSProgressIndicator(frame: NSRect(x: 20, y: 24, width: 380, height: 20))
        bar.style = .bar
        bar.minValue = 0
        bar.maxValue = 100
        bar.isIndeterminate = false
        window.contentView?.addSubview(label)
        window.contentView?.addSubview(bar)
        window.center()
        window.makeKeyAndOrderFront(nil)
        progressWindow = window
        progressBar = bar
        progressLabel = label
    }

    private func run(_ tool: String, _ args: [String]) -> (status: Int32, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, error.localizedDescription) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
    }
}

private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
    let progress: (Double) -> Void
    let finished: (Result<URL, Error>) -> Void
    init(progress: @escaping (Double) -> Void, finished: @escaping (Result<URL, Error>) -> Void) {
        self.progress = progress
        self.finished = finished
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let fraction = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        DispatchQueue.main.async { self.progress(fraction) }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The temp file is deleted when this returns: move it somewhere durable first.
        let kept = FileManager.default.temporaryDirectory.appendingPathComponent("dsh-update-\(UUID().uuidString).dmg")
        do {
            try FileManager.default.moveItem(at: location, to: kept)
            if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
                finished(.failure(UpdateError.badFeed("download HTTP \(http.statusCode)")))
            } else {
                finished(.success(kept))
            }
        } catch {
            finished(.failure(error))
        }
        session.finishTasksAndInvalidate()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finished(.failure(error)) }
    }
}
