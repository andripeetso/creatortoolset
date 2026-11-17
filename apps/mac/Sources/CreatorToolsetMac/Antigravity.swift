// Google's Antigravity agent server: the program this app's own server downloads into the app's data folder
// (apps/captions/api/lib/antigravity.ts, which writes the layout below), started here for a chat over the Agent Client
// Protocol (AcpRun.swift). runtime/ holds the program, its harness and release.json (version and sizes, written last);
// profile/ is its own settings folder (GEMINI_HOME), with the Google sign-in in antigravity-acp/acp_token.json.
import Foundation

let antigravityRoot = appSupport.appendingPathComponent("antigravity", isDirectory: true)
let antigravityHarnessName = "localharness_external"
let antigravityMissing = "Antigravity is not installed on this Mac. Install it in Settings → Providers"
let antigravitySignedOut = "Antigravity is not signed in on this Mac. Sign in in Settings → Providers"

/// The program a chat starts, the harness beside it, and the version its release.json names (nil for a person's own copy).
struct AntigravityRuntime: Equatable {
    let program: String
    let harness: String
    let version: String?
}

/// A person's own copy (the provider's program path, with its harness beside it), else the copy this app downloaded:
/// release.json and both files at the sizes it names, so a half-finished download is none. Nil when neither is there.
func antigravityRuntime(custom: String = "", root: URL = antigravityRoot) -> AntigravityRuntime? {
    let fm = FileManager.default
    if !custom.isEmpty {
        guard let program = which(custom) else { return nil }
        let harness = URL(fileURLWithPath: program).resolvingSymlinksInPath().deletingLastPathComponent()
            .appendingPathComponent(antigravityHarnessName).path
        return fm.isExecutableFile(atPath: harness) ? AntigravityRuntime(program: program, harness: harness, version: nil) : nil
    }
    let dir = root.appendingPathComponent("runtime", isDirectory: true)
    guard let data = try? Data(contentsOf: dir.appendingPathComponent("release.json")),
          let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let version = record["version"] as? String,
          let files = record["files"] as? [[String: Any]], files.count == 2 else { return nil }
    var paths: [String] = []
    for file in files {
        guard let name = file["name"] as? String, !name.contains("/"), let bytes = file["bytes"] as? Int else { return nil }
        let path = dir.appendingPathComponent(name).path
        let size = ((try? fm.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.intValue
        guard size == bytes, fm.isExecutableFile(atPath: path) else { return nil }
        paths.append(path)
    }
    return AntigravityRuntime(program: paths[0], harness: paths[1], version: version)
}

/// Signed in: the token its Google sign-in saved is in the profile (existence only; the program reads its own file).
func antigravitySignedIn(root: URL = antigravityRoot) -> Bool {
    FileManager.default.fileExists(atPath: root.appendingPathComponent("profile/antigravity-acp/acp_token.json").path)
}

/// The settings a run starts with: its profile folder, the harness, its token in a file (no Keychain prompt), and a
/// browser that opens nothing. A chat never opens a sign-in page by itself; a run whose sign-in is gone fails with
/// "Authentication required" instead. Only the Sign in button opens Google's page (antigravitySignIn).
func antigravityEnv(_ runtime: AntigravityRuntime, root: URL = antigravityRoot, browser: Bool = false) -> [String: String] {
    var env = ["GEMINI_HOME": root.appendingPathComponent("profile").path, "ANTIGRAVITY_HARNESS_PATH": runtime.harness,
               "AGY_ACP_FORCE_FILE_STORAGE": "1", "PYTHONUNBUFFERED": "1"]
    if !browser { env["BROWSER"] = "/usr/bin/true" }
    return env
}

/// The provider page's Sign in button on this Mac (Shell.signIn): the program is asked to sign in with a Google account
/// (`authenticate`, oauth-personal), opens Google's page in the default browser and waits for it there, five minutes at
/// most; the answer saves the token. The settings file names the Google account as the way in, so a chat needs no sign-in
/// step after this. One at a time: a new press stops the last.
final class AntigravityLogin {
    private var run: AcpRun?

    func start(root: URL = antigravityRoot, custom: String = "") {
        run?.close()
        guard let runtime = antigravityRuntime(custom: custom, root: root) else { return AppLog.write("sign in: \(antigravityMissing)") }
        let settings = root.appendingPathComponent("profile/antigravity-acp", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: settings, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try Data(#"{"auth":{"type":"oauth-personal"}}"#.utf8).write(to: settings.appendingPathComponent("settings.json"))
            var env = driverEnv(base: ProcessInfo.processInfo.environment).merging(antigravityEnv(runtime, root: root, browser: true)) { _, own in own }
            env["BROWSER"] = nil
            let run = try AcpRun(command: AcpCommand(executable: runtime.program, arguments: [], cwd: root, environment: env))
            self.run = run
            Thread {
                do { try run.signIn(method: "oauth-personal", timeout: 5 * 60) } catch { AppLog.write("sign in: antigravity \(error)") }
                run.close()
            }.start()
        } catch {
            AppLog.write("sign in: antigravity did not start (\(error.localizedDescription))")
        }
    }
}
