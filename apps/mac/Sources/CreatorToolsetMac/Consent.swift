// What a server may make this Mac do, decided on this Mac. A server (the studio, a hosted site, the server on this Mac
// with its plug-ins' pages) sends AI jobs; the Mac runs them. With the app's own programs and their own setup, nothing is
// asked. Anything past that is this Mac's yes, given once in its own alert and kept here, never the server's:
// - a program the server names (a local ACP command, a manual setup's program, extra launch arguments),
// - a settings folder the server names (a Claude, Codex or Gemini home: its hooks and settings can start programs),
// - who answers the assistant's questions before it runs a command or changes a file: the server's chat only once this
//   Mac said so for that server; otherwise each question is asked here.
// A "no" silences that server's asks for the rest of the run, so a page that changes the command each time can't fill
// the screen with alerts. One alert at a time across all jobs.
import AppKit
import Foundation

/// The things a job asks for past the app's defaults, as exact lines for the alert and the kept yes. Empty = nothing to ask.
func launchNeeds(_ req: RelayRequest, _ opts: RelayOptions, resolve: (String) -> String? = which) -> [ConsentItem] {
    var needs: [ConsentItem] = []
    if let acp = opts.acp, req.driver == "acp" || !req.binaryPath.isEmpty || !req.launchArgs.isEmpty {
        let program = resolve(acp.command) ?? acp.command
        needs.append(ConsentItem(kind: .program, text: ([program] + acp.args).joined(separator: " ")))
    }
    if !opts.home.isEmpty { needs.append(ConsentItem(kind: .folder, text: opts.home)) }
    return needs
}

struct ConsentItem: Equatable, Hashable {
    enum Kind: String { case program, folder }
    let kind: Kind
    /// The exact program and arguments, or the folder: what the alert shows and what the yes is kept for.
    let text: String
    var key: String { "\(kind.rawValue):\(text)" }
}

/// Text from a server, fit for an alert: one line, no control characters, at most `max` long. Nil when it is longer:
/// an alert never shows a shortened command, it refuses it.
func alertLine(_ text: String, max: Int = 400) -> String? {
    let line = text.components(separatedBy: .controlCharacters).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    return line.isEmpty || line.count > max ? nil : line
}

/// The words of each alert. `host` is the server's own host name.
enum ConsentWords {
    static func program(_ host: String, _ command: String) -> (String, String) {
        ("Let \(host) start a program on this Mac?",
         "It asks to run: \(command)\n\nAllow it only if you set this program up yourself, in Settings → Providers.")
    }
    static func folder(_ host: String, _ path: String) -> (String, String) {
        ("Let \(host) use this settings folder on this Mac?",
         "\(path)\n\nA settings folder can make the AI start programs. Allow it only if you set it up yourself, in Settings → Providers.")
    }
    static func askTrust(_ host: String) -> (String, String) {
        ("Let \(host) answer the assistant's questions?",
         "Before the assistant runs a command or changes a file on this Mac, it asks. With this on, you answer in the assistant's chat on any device signed in to \(host). With it off, each question is asked here on this Mac.")
    }
    static func ask(_ description: String, _ detail: String) -> (String, String) {
        ("The assistant wants to: \(description)", detail)
    }
}

/// This Mac's kept answers, per server host: the items allowed, and whether its chat may answer the assistant's questions.
struct ConsentStore {
    var defaults: UserDefaults = .standard

    func allowed(_ host: String) -> Set<String> { Set(defaults.stringArray(forKey: "consent.allowed.\(host)") ?? []) }
    func allow(_ host: String, _ item: ConsentItem) {
        defaults.set(Array(allowed(host).union([item.key])).sorted(), forKey: "consent.allowed.\(host)")
    }
    /// nil = never asked; true = the server's chat answers; false = each question is asked on this Mac.
    func chatAnswers(_ host: String) -> Bool? { defaults.object(forKey: "consent.chat.\(host)") as? Bool }
    func setChatAnswers(_ host: String, _ on: Bool) { defaults.set(on, forKey: "consent.chat.\(host)") }
}

/// Shows one alert and waits for it, from a job's thread: true = the second button (the yes). The app sets it (Shell);
/// tests and a Mac with no window answer no.
typealias ConsentPrompt = (_ title: String, _ detail: String, _ yes: String, _ no: String) -> Bool

/// One server's consent for the jobs it sends. Thread-safe: jobs run in parallel, alerts one at a time.
final class Consent {
    let host: String
    private let store: ConsentStore
    private let prompt: ConsentPrompt
    private let lock = NSLock()
    private let oneAlert = NSLock()
    private var silenced = false

    init(host: String, store: ConsentStore = ConsentStore(), prompt: @escaping ConsentPrompt) {
        self.host = host
        self.store = store
        self.prompt = prompt
    }

    private var isSilenced: Bool { lock.lock(); defer { lock.unlock() }; return silenced }
    private func silence() { lock.lock(); silenced = true; lock.unlock() }

    /// One alert at a time; a no to a launch silences this server's launch asks for the rest of the run.
    private func show(_ words: (String, String), yes: String, no: String) -> Bool {
        oneAlert.lock()
        defer { oneAlert.unlock() }
        return prompt(words.0, words.1, yes, no)
    }

    /// Throws when a job asks for something this Mac has not allowed, after asking once (a yes is kept).
    func check(_ needs: [ConsentItem]) throws {
        let kept = store.allowed(host)
        for item in needs where !kept.contains(item.key) {
            guard !isSilenced, let line = alertLine(item.text) else { throw refused(item) }
            let words = item.kind == .program ? ConsentWords.program(host, line) : ConsentWords.folder(host, line)
            guard show(words, yes: "Allow", no: "Don't Allow") else {
                silence()
                throw refused(item)
            }
            store.allow(host, item)
        }
    }

    private func refused(_ item: ConsentItem) -> RelayError {
        RelayError(message: item.kind == .program
            ? "This Mac did not allow \(host) to start that program. Allow it on the Mac when it asks, or pick another AI in Settings → Providers."
            : "This Mac did not allow \(host) to use that settings folder. Allow it on the Mac when it asks, or clear the folder in Settings → Providers.")
    }

    /// Whether the server's chat answers the assistant's questions: asked on this Mac the first time, then kept.
    func chatAnswers() -> Bool {
        if let kept = store.chatAnswers(host) { return kept }
        let on = show(ConsentWords.askTrust(host), yes: "Allow", no: "Ask on This Mac")
        store.setChatAnswers(host, on)
        return on
    }

    /// One of the assistant's questions, answered on this Mac: "allowed" or "denied".
    func askHere(_ description: String, _ detail: String) -> String {
        let words = ConsentWords.ask(alertLine(description, max: 300) ?? "do something it couldn't describe", alertLine(detail, max: 1000) ?? "")
        return show(words, yes: "Allow", no: "Don't Allow") ? "allowed" : "denied"
    }
}

/// The app's prompt: its own alert over the window, from any thread, waiting up to 10 minutes (then no).
@MainActor
func windowConsentPrompt(window: @escaping @MainActor () -> NSWindow?) -> ConsentPrompt {
    return { title, detail, yes, no in
        let done = DispatchSemaphore(value: 0)
        let answer = ConsentAnswer()
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = detail
            alert.addButton(withTitle: no)
            alert.addButton(withTitle: yes)
            // no default button: Return does nothing, only a click on the yes agrees (as the plug-in alert)
            alert.buttons[0].keyEquivalent = "\u{1b}"
            alert.buttons[1].keyEquivalent = ""
            NSApp.activate(ignoringOtherApps: true)
            let finish: (NSApplication.ModalResponse) -> Void = { response in
                answer.set(response == .alertSecondButtonReturn)
                done.signal()
            }
            if let w = window() { alert.beginSheetModal(for: w, completionHandler: finish) } else { finish(alert.runModal()) }
        }
        return done.wait(timeout: .now() + 600) == .success && answer.value
    }
}

private final class ConsentAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var yes = false
    func set(_ v: Bool) { lock.lock(); yes = v; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return yes }
}
