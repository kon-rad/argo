import AppKit
import Foundation
import ImageIO

/// Runs the `agent-dock` CLI that ships inside the app bundle and decodes what it prints.
enum DockCLI {
    struct Failed: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    static var path: String {
        if let own = ProcessInfo.processInfo.environment["AGENT_DOCK_CLI"], !own.isEmpty { return own }
        return Bundle.main.resourceURL?.appendingPathComponent("agent-dock").path ?? "agent-dock"
    }

    static func call<T: Decodable>(_ type: T.Type, _ args: [String]) throws -> T {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args + ["--json"]
        let out = Pipe()
        let err = Pipe()
        p.standardOutput = out
        p.standardError = err
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        if let failure = try? JSONDecoder().decode(DockFailure.self, from: data) {
            throw Failed(message: failure.error)
        }
        guard p.terminationStatus == 0 else {
            let text = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw Failed(message: text.isEmpty ? "agent-dock exited \(p.terminationStatus)" : text)
        }
        return try JSONDecoder().decode(type, from: data)
    }
}

struct Launched: Codable { let launched: String }

/// Small, cached avatar images: the portraits in a vault are full-size files.
enum Avatars {
    private static let cache = NSCache<NSString, NSImage>()

    static func image(_ path: String?, side: CGFloat = 240) -> NSImage? {
        guard let path, !path.isEmpty else { return nil }
        if let hit = cache.object(forKey: path as NSString) { return hit }
        let url = URL(fileURLWithPath: path) as CFURL
        guard let src = CGImageSourceCreateWithURL(url, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: side,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let image = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        cache.setObject(image, forKey: path as NSString)
        return image
    }
}

@MainActor
final class Store: ObservableObject {
    @Published var pane: Pane = .agents
    @Published var roster: Roster?
    @Published var snapshot: Snapshot?
    @Published var history: [Run] = []
    @Published var problem: String?
    @Published var notice: String?
    @Published var vault: String = Store.savedVault()

    private var timer: Timer?

    static func savedVault() -> String {
        if let v = UserDefaults.standard.string(forKey: "vaultPath"), !v.isEmpty { return v }
        if let v = Bundle.main.object(forInfoDictionaryKey: "SBVaultPath") as? String, !v.isEmpty { return v }
        return ProcessInfo.processInfo.environment["SECONDBRAIN_VAULT"] ?? ""
    }

    func start() {
        loadRoster()
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func chooseVault() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Use this vault"
        panel.message = "Choose the vault folder (the one that holds secondbrain.json)."
        if panel.runModal() == .OK, let url = panel.url {
            vault = url.path
            UserDefaults.standard.set(vault, forKey: "vaultPath")
            loadRoster()
        }
    }

    func loadRoster() {
        guard !vault.isEmpty else {
            roster = nil
            problem = "No vault chosen yet."
            return
        }
        let v = vault
        Task.detached {
            do {
                let r = try DockCLI.call(Roster.self, ["roster", "--vault", v])
                await MainActor.run { self.roster = r; self.problem = nil }
            } catch {
                await MainActor.run { self.roster = nil; self.problem = error.localizedDescription }
            }
        }
    }

    func refresh() {
        Task.detached {
            let snap = try? DockCLI.call(Snapshot.self, ["ps", "--record"])
            let hist = try? DockCLI.call(History.self, ["history", "--limit", "300"])
            await MainActor.run {
                if let snap { self.snapshot = snap }
                if let hist { self.history = hist.runs }
            }
        }
    }

    func launch(_ agent: Agent, _ runtime: Runtime) {
        let v = vault
        notice = "Opening \(agent.displayName) on \(runtime.label)..."
        Task.detached {
            do {
                _ = try DockCLI.call(Launched.self, ["launch", agent.name, "--runtime", runtime.id, "--vault", v])
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                await MainActor.run { self.notice = nil; self.refresh() }
            } catch {
                await MainActor.run { self.notice = nil; self.problem = error.localizedDescription }
            }
        }
    }
}
