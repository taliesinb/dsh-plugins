// Embedded server mode: the bundled app (DSH.dmg) carries a Node runtime and a
// self-contained DSH installation under Contents/Resources and runs the server
// itself instead of expecting a relay LaunchAgent started from a source
// checkout. Configured by the `embedded` block of dsh-dock-app.json:
//
//   "embedded": { "node": "node/bin/node",
//                 "dsh": "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js",
//                 "profile": "app", "port": 3090,
//                 "profileTemplate": "profile-template", "dshHome": null }
//
// Paths are Resources-relative. On launch the app
//   1. ensures `$DSH_HOME/profiles/<profile>` exists — created from the
//      template on first run; on later runs every bundle the template lists
//      that the profile lacks is appended (a new release carrying a new plugin
//      must reach existing installs, while bundles the user added through the
//      Plugins panel stay);
//   2. spawns `node bin.js <profile> --no-open --port <port>` through
//      `/bin/zsh -lc` so the operator's login-shell PATH and exported keys
//      reach the agent's tools (the same reason the relay does it);
//   3. reads the child's stdout for the `dsh web: http://127.0.0.1:…/?token=…`
//      line and hands that URL to the window; everything the child prints is
//      appended to `$DSH_HOME/logs/dsh-app.log`;
//   4. on quit sends SIGTERM and waits up to five seconds before SIGKILL.
// A child that exits on its own is reported to the window (offline page with
// the last stderr lines); the window's retry restarts it.

import Foundation

struct EmbeddedSpec: Decodable {
    var node: String
    var dsh: String
    var profile: String
    var port: Int
    var profileTemplate: String?
    var dshHome: String?
}

final class EmbeddedServer {
    let spec: EmbeddedSpec
    let resources: URL
    let log: (String) -> Void
    private(set) var process: Process?
    private var stdoutBuffer = ""
    private var stderrTail: [String] = []
    private var announced = false
    /// Fired on the main queue once with the tokened loopback URL.
    var onReady: ((URL) -> Void)?
    /// Fired on the main queue when the child exits (status, last stderr lines). Not fired for stop().
    var onExit: ((Int32, [String]) -> Void)?
    private var stopping = false

    init(spec: EmbeddedSpec, resources: URL, log: @escaping (String) -> Void) {
        self.spec = spec
        self.resources = resources
        self.log = log
    }

    /// `$DSH_HOME` from the environment, else the spec's (`~` expanded), else `~/.dsh`.
    var dshHome: URL {
        if let env = ProcessInfo.processInfo.environment["DSH_HOME"], !env.isEmpty { return URL(fileURLWithPath: env) }
        if let configured = spec.dshHome, !configured.isEmpty {
            return URL(fileURLWithPath: (configured as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dsh", isDirectory: true)
    }

    var nodeURL: URL { resources.appendingPathComponent(spec.node) }
    var dshURL: URL { resources.appendingPathComponent(spec.dsh) }
    var profileDir: URL { dshHome.appendingPathComponent("profiles/\(spec.profile)", isDirectory: true) }
    var logFile: URL { dshHome.appendingPathComponent("logs/dsh-app.log") }

    // MARK: profile

    /// Create the profile from the template, or append template bundles the profile lacks.
    func prepareProfile() throws {
        guard let templateName = spec.profileTemplate else { return }
        let template = resources.appendingPathComponent(templateName, isDirectory: true)
        let fm = FileManager.default
        let manifest = profileDir.appendingPathComponent("package.json")
        let templateManifest = template.appendingPathComponent("package.json")
        try fm.createDirectory(at: profileDir, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: manifest.path) {
            try fm.copyItem(at: templateManifest, to: manifest)
            log("embedded: created profile \(profileDir.path) from the bundled template")
        } else {
            try mergeBundles(into: manifest, from: templateManifest)
        }
        let patch = profileDir.appendingPathComponent("cordis.patch.yml")
        if !fm.fileExists(atPath: patch.path) {
            let templatePatch = template.appendingPathComponent("cordis.patch.yml")
            if fm.fileExists(atPath: templatePatch.path) { try fm.copyItem(at: templatePatch, to: patch) }
            else { try "[]\n".write(to: patch, atomically: true, encoding: .utf8) }
        }
    }

    private func mergeBundles(into manifest: URL, from templateManifest: URL) throws {
        guard var profile = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any],
              let template = try JSONSerialization.jsonObject(with: Data(contentsOf: templateManifest)) as? [String: Any] else { return }
        let templateBundles = ((template["dsh"] as? [String: Any])?["profile"] as? [String: Any])?["bundles"] as? [String] ?? []
        var dsh = profile["dsh"] as? [String: Any] ?? [:]
        var section = dsh["profile"] as? [String: Any] ?? [:]
        var bundles = section["bundles"] as? [String] ?? []
        let missing = templateBundles.filter { !bundles.contains($0) }
        guard !missing.isEmpty else { return }
        bundles.append(contentsOf: missing)
        section["bundles"] = bundles
        dsh["profile"] = section
        profile["dsh"] = dsh
        let data = try JSONSerialization.data(withJSONObject: profile, options: [.prettyPrinted, .sortedKeys])
        try (String(data: data, encoding: .utf8)! + "\n").write(to: manifest, atomically: true, encoding: .utf8)
        log("embedded: added bundles \(missing.joined(separator: ", ")) to \(manifest.path)")
    }

    // MARK: process

    func start() {
        stopping = false
        announced = false
        stdoutBuffer = ""
        stderrTail = []
        do { try prepareProfile() } catch {
            log("embedded: profile preparation failed: \(error)")
            DispatchQueue.main.async { self.onExit?(-1, ["profile preparation failed: \(error.localizedDescription)"]) }
            return
        }
        try? FileManager.default.createDirectory(at: logFile.deletingLastPathComponent(), withIntermediateDirectories: true)

        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // `-l` for the operator's login-shell environment; `exec "$@"` keeps node as the direct child (signals reach it).
        child.arguments = ["-lc", "exec \"$@\"", "dsh-app", nodeURL.path, dshURL.path, spec.profile, "--no-open", "--port", String(spec.port)]
        var env = ProcessInfo.processInfo.environment
        env["DSH_HOME"] = dshHome.path
        env["DSH_APP_BUNDLE"] = Bundle.main.bundlePath
        env["DSH_APP_VERSION"] = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? ""
        child.environment = env
        child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

        let stdout = Pipe(), stderr = Pipe(), stdin = Pipe()
        child.standardOutput = stdout
        child.standardError = stderr
        child.standardInput = stdin   // kept open: a lifeline the server can watch for the wrapper's death
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self, !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            self.append(text)
            self.stdoutBuffer += text
            self.scanForURL()
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self, !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            self.append(text)
            for line in text.split(separator: "\n") where !line.isEmpty {
                self.stderrTail.append(String(line))
                if self.stderrTail.count > 12 { self.stderrTail.removeFirst() }
            }
        }
        child.terminationHandler = { [weak self] proc in
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            guard let self else { return }
            let status = proc.terminationStatus
            self.log("embedded: server exited with status \(status)")
            if self.stopping { return }
            let tail = self.stderrTail
            DispatchQueue.main.async { self.onExit?(status, tail) }
        }
        do {
            try child.run()
            process = child
            log("embedded: started \(nodeURL.lastPathComponent) pid \(child.processIdentifier) profile \(spec.profile) port \(spec.port) home \(dshHome.path)")
        } catch {
            log("embedded: could not start the server: \(error)")
            DispatchQueue.main.async { self.onExit?(-1, ["could not start \(self.nodeURL.path): \(error.localizedDescription)"]) }
        }
    }

    private func scanForURL() {
        guard !announced else { return }
        // `dsh web: http://127.0.0.1:3090/?token=…` — the first http(s) URL the launcher prints.
        guard let range = stdoutBuffer.range(of: #"dsh web: (https?://\S+)"#, options: .regularExpression) else { return }
        let line = String(stdoutBuffer[range])
        let text = line.replacingOccurrences(of: "dsh web: ", with: "")
        guard let url = URL(string: text) else { return }
        announced = true
        DispatchQueue.main.async { self.onReady?(url) }
    }

    /// SIGTERM, then SIGKILL after `timeout` seconds. Blocks the caller.
    func stop(timeout: TimeInterval = 5) {
        guard let child = process, child.isRunning else { return }
        stopping = true
        child.terminate()
        let deadline = Date().addingTimeInterval(timeout)
        while child.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if child.isRunning {
            log("embedded: server did not exit within \(Int(timeout))s, killing")
            kill(child.processIdentifier, SIGKILL)
        }
        process = nil
    }

    private func append(_ text: String) {
        if let handle = try? FileHandle(forWritingTo: logFile) {
            defer { try? handle.close() }
            try? handle.seekToEnd()
            handle.write(Data(text.utf8))
        } else {
            try? text.write(to: logFile, atomically: true, encoding: .utf8)
        }
    }
}

extension String {
    /// Minimal HTML escaping for text spliced into the wrapper's own pages.
    var htmlEscaped: String {
        replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}
