import AppKit
import WebKit
import XCTest
@testable import CreatorToolsetMac

/// A card's script is someone's AI output and is never trusted. Each test lets a script try something and looks at what
/// came of it from outside: a listener on 127.0.0.1 (FakeSite), a file, the page's own process. Each has a control: the
/// same script in the same kind of web view with the walls taken away reaches what it was after, so "nothing arrived"
/// means the walls held and not that the script was wrong.
@MainActor
final class KitSandboxTests: XCTestCase {
    private func card(_ kit: String) -> KitCard {
        KitCard(kit: kit, width: 320, height: 180, seconds: 1, fps: 4, content: ["text": "Tiny Acrobatics"])
    }

    /// The script as every card is drawn: in its frame, behind every wall.
    private func shutIn(_ kit: String) async throws -> KitWebView {
        let page = try KitWebView(width: 320, height: 180)
        try await page.load(try KitRunner.page(for: card(kit)))
        return page
    }

    /// The control: the script's page with no policy and no frame, in a web view with these walls only (none by default).
    /// A script that leaves its page ends the load early, which is the point.
    private func open(_ kit: String, walls: KitWalls = [], proxyPort: UInt16 = KitRunner.deadPort) async throws -> KitWebView {
        let page = try KitWebView(width: 320, height: 180, walls: walls, proxyPort: proxyPort)
        try? await page.load(noPolicy(try KitRunner.html(for: card(kit))))
        return page
    }

    private func noPolicy(_ html: String) -> String {
        html.components(separatedBy: "\n").filter { !$0.contains("Content-Security-Policy") }.joined(separator: "\n")
    }

    private func pause(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    /// Ends a control's page and forgets what it sent, so nothing of it arrives while the walls are tried.
    private func done(_ control: KitWebView, _ site: FakeSite) async {
        control.end()
        await pause(0.4)
        site.forget()
    }

    /// Whether the process is gone within `seconds`.
    private func gone(_ pid: pid_t, within seconds: Double = 3) async -> Bool {
        for _ in 0..<Int(seconds * 10) {
            if !KitWebView.isPageProcess(pid) { return true }
            await pause(0.1)
        }
        return false
    }

    // MARK: no network

    /// Everything the page's policy governs, each to a path of its own.
    private func loads(_ port: UInt16) -> String {
        """
        const B = 'http://127.0.0.1:\(port)';
        fetch(B + '/fetch', { mode: 'no-cors' }).catch(() => {});
        try { const x = new XMLHttpRequest(); x.open('GET', B + '/xhr'); x.send(); } catch (e) {}
        new Image().src = B + '/img';
        try { navigator.sendBeacon(B + '/beacon', 'x'); } catch (e) {}
        try { new WebSocket('ws://127.0.0.1:\(port)/ws'); } catch (e) {}
        try { new EventSource(B + '/events'); } catch (e) {}
        try { new Worker(B + '/worker'); } catch (e) {}
        try { import(B + '/module').catch(() => {}); } catch (e) {}
        for (const [tag, attrs] of [['link', { rel: 'stylesheet', href: B + '/css' }], ['script', { src: B + '/js' }], ['iframe', { src: B + '/frame' }],
            ['video', { src: B + '/video' }], ['object', { data: B + '/object' }], ['embed', { src: B + '/embed' }], ['link', { rel: 'preload', href: B + '/preload', as: 'fetch' }]]) {
          const el = document.createElement(tag); for (const k in attrs) el.setAttribute(k, attrs[k]); document.body.appendChild(el);
        }
        const style = document.createElement('style');
        style.textContent = "@import url('" + B + "/import'); @font-face{font-family:x;src:url('" + B + "/font')} body{font-family:x;background-image:url('" + B + "/cssimg')}";
        document.head.appendChild(style);
        document.body.insertAdjacentHTML('beforeend', '<svg width="10" height="10"><image href="' + B + '/svgimage" width="10" height="10"/></svg>');
        function kitFrame() {}
        """
    }

    func testAScriptCannotLoadOrSendAnything() async throws {
        let site = FakeSite()
        let control = try await open(loads(site.port))
        await pause(2.5)
        let reached = Set(site.requests.map(\.path))
        for path in ["/fetch", "/xhr", "/img", "/beacon", "/ws", "/css", "/js", "/frame", "/import", "/cssimg", "/svgimage"] {
            XCTAssertTrue(reached.contains(path), "the control reaches \(path), so the script's try is a real one")
        }
        await done(control, site)

        let page = try await shutIn(loads(site.port))
        await pause(2.5)
        XCTAssertEqual(site.requests.map(\.path), [])
        XCTAssertEqual(site.connections, 0)
        try await page.paint(at: 0.5)   // and its page is still the card's
    }

    func testAScriptCannotOpenAConnectionByALink() async throws {
        // found by measuring: the page's policy does not govern these two, and the web view is not asked first
        let site = FakeSite()
        let b = "http://127.0.0.1:\(site.port)"
        let ways = [
            "preconnect": "const l = document.createElement('link'); l.rel = 'preconnect'; l.href = '\(b)'; document.head.appendChild(l);",
            "a click on a link that opens a new window": "const a = document.createElement('a'); a.href = '\(b)/blank'; a.target = '_blank'; document.body.appendChild(a); a.click();",
        ]
        for (name, js) in ways {
            site.forget()
            let control = try await open(js + "\nfunction kitFrame() {}")
            await pause(1.5)
            XCTAssertGreaterThan(site.connections, 0, "the control connects by \(name)")
            await done(control, site)

            let page = try await shutIn(js + "\nfunction kitFrame() {}")
            await pause(1.5)
            XCTAssertEqual(site.connections, 0, name)
            page.end()
        }
    }

    func testAScriptHasNoWebRTC() async throws {
        // the policy does not govern WebRTC either: its packets to a STUN server and its connection to a TURN server
        let site = FakeSite()
        let stun = PacketCounter()
        let js = """
        window.tried = 'no';
        try {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:\(stun.port)' }, { urls: 'turn:127.0.0.1:\(site.port)?transport=tcp', username: 'u', credential: 'p' }] });
          pc.createDataChannel('x');
          pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {});
          window.tried = 'yes';
        } catch (e) { window.tried = String(e); }
        function kitFrame() {}
        """
        let control = try await open(js)
        await pause(4)
        let triedOpen = try await control.run("window.tried")
        XCTAssertEqual(triedOpen, "yes")
        XCTAssertGreaterThan(stun.packets, 0, "the control's packets arrive")
        XCTAssertGreaterThan(site.connections, 0, "the control's connection arrives")
        await done(control, site)

        let before = stun.packets
        let page = try await shutIn(js)
        await pause(4)
        let tried = try await page.run("window.tried")
        XCTAssertTrue(tried.contains("RTCPeerConnection"), tried)   // "ReferenceError: Can't find variable: RTCPeerConnection"
        XCTAssertEqual(stun.packets, before)
        XCTAssertEqual(site.connections, 0)
    }

    func testWhatHeadsOutsideThisMacGoesToTheDeadProxy() async throws {
        // A name outside this Mac, asked for by a page with no policy at all: with the proxy wall it is handed to the
        // proxy address (here a listener, to see it; for a card, a port where nothing listens), never looked up or reached.
        let proxy = FakeSite()
        let page = try await open("fetch('http://card-probe.invalid/x', { mode: 'no-cors' }).catch(() => {});\nfunction kitFrame() {}", walls: [.deadProxy], proxyPort: proxy.port)
        await pause(2.5)
        XCTAssertGreaterThan(proxy.connections, 0, "the request went to the proxy address")
        page.end()
    }

    // MARK: no files

    func testAScriptCannotOpenAFile() async throws {
        let dir = testFolder("card-file")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let secret = dir.appendingPathComponent("secret.txt")
        try Data("tiny-secret".utf8).write(to: secret)
        let js = """
        const R = window.R = {};
        fetch('\(secret.absoluteString)').then(r => r.text()).then(t => R.fetch = t, () => {});
        try { const x = new XMLHttpRequest(); x.open('GET', '\(secret.absoluteString)'); x.onload = () => R.xhr = x.responseText; x.send(); } catch (e) {}
        try { const f = document.createElement('iframe'); f.onload = () => { try { R.frame = f.contentDocument.body.textContent } catch (e) {} }; f.src = '\(secret.absoluteString)'; document.body.appendChild(f); } catch (e) {}
        setTimeout(() => { try { top.location.href = '\(secret.absoluteString)'; } catch (e) {} }, 300);
        setTimeout(() => { location.href = '\(secret.absoluteString)'; }, 600);
        function kitFrame() {}
        """
        // the control: a page that is itself a file in that folder, with leave to read it, gets there
        let control = try KitWebView(width: 320, height: 180, walls: [])
        let file = dir.appendingPathComponent("page.html")
        try noPolicy(try KitRunner.html(for: card(js))).write(to: file, atomically: true, encoding: .utf8)
        control.webView.loadFileURL(file, allowingReadAccessTo: dir)
        await pause(2.5)
        let read = try await control.run("document.body ? document.body.textContent : ''")
        XCTAssertTrue(read.contains("tiny-secret"), "the control reads the file: \(read)")
        control.end()

        let page = try await shutIn(js)
        await pause(2.5)
        let found = try await page.run("JSON.stringify(window.R) + ' ' + document.URL + ' ' + document.body.textContent")
        XCTAssertFalse(found.contains("tiny-secret"), found)
        XCTAssertTrue(found.contains("about:srcdoc"), found)
        XCTAssertEqual(page.webView.url?.absoluteString, "about:blank")
        try await page.paint(at: 0.5)
    }

    // MARK: no way off its page

    func testAScriptCannotLeaveItsPage() async throws {
        let site = FakeSite()
        let b = "http://127.0.0.1:\(site.port)"
        // the control: three of the ways, each in a page of its own (it works, so the page is gone afterwards)
        for (path, js) in [("/nav", "location.href = '\(b)/nav';"),
                           ("/form", "const f = document.createElement('form'); f.action = '\(b)/form'; f.method = 'POST'; document.body.appendChild(f); f.submit();"),
                           ("/a", "const a = document.createElement('a'); a.href = '\(b)/a'; document.body.appendChild(a); a.click();")] {
            let control = try await open(js + "\nfunction kitFrame() {}")
            await pause(1)
            XCTAssertTrue(site.requests.contains { $0.path == path }, "the control leaves by \(path)")
            await done(control, site)
        }

        // every way at once: none works, so the page is still there to try the next
        let page = try await shutIn("""
        const tries = [
          () => { location.href = '\(b)/nav'; },
          () => { location.replace('\(b)/replace'); },
          () => { top.location.href = '\(b)/top'; },
          () => { parent.location.href = '\(b)/parent'; },
          () => { window.open('\(b)/open'); },
          () => { const a = document.createElement('a'); a.href = '\(b)/a'; document.body.appendChild(a); a.click(); },
          () => { const a = document.createElement('a'); a.href = '\(b)/atop'; a.target = '_top'; document.body.appendChild(a); a.click(); },
          () => { const a = document.createElement('a'); a.href = '\(b)/aevent'; document.body.appendChild(a); a.dispatchEvent(new MouseEvent('click', { bubbles: true })); },
          () => { const f = document.createElement('form'); f.action = '\(b)/form'; f.method = 'POST'; document.body.appendChild(f); f.submit(); },
          () => { const f = document.createElement('form'); f.action = '\(b)/formtop'; f.target = '_top'; document.body.appendChild(f); f.submit(); },
          () => { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=\(b)/meta'; document.head.appendChild(m); },
          () => { const f = document.createElement('iframe'); document.body.appendChild(f); f.contentWindow.location.href = '\(b)/nested'; },
          () => { const f = document.createElement('iframe'); document.body.appendChild(f); const a = f.contentDocument.createElement('a'); a.href = '\(b)/nestedtop'; a.target = '_top'; f.contentDocument.body.appendChild(a); a.click(); },
          () => { location.href = URL.createObjectURL(new Blob(['<script>fetch("\(b)/blob")<\\/script>'], { type: 'text/html' })); },
          () => { location.href = 'creatortoolset://account?code=tiny'; },
        ];
        window.threw = 0;
        tries.forEach((t, i) => setTimeout(() => { try { t(); } catch (e) { window.threw++; } }, 40 * i));
        function kitFrame(t) { document.getElementById('stage').style.background = 'rgb(0,255,0)'; }
        """)
        await pause(2.5)
        XCTAssertEqual(site.requests.map(\.path), [])
        XCTAssertEqual(site.connections, 0)
        XCTAssertEqual(page.webView.url?.absoluteString, "about:blank", "the page above the script's frame never moved")
        let still = try await page.run("document.URL + ' ' + typeof kitFrame")
        XCTAssertEqual(still, "about:srcdoc function", "the script is still in its own frame")
        try await page.paint(at: 0.5)
    }

    func testAScriptGetsNothingOfTheApps() async throws {
        let page = try await shutIn("function kitFrame() {}")
        let has = try await page.run("""
        JSON.stringify({
          handlers: typeof window.webkit,
          cookie: (function () { try { return document.cookie } catch (e) { return 'refused' } })(),
          storage: (function () { try { localStorage.setItem('a', 'b'); return 'kept' } catch (e) { return 'refused' } })(),
          origin: self.origin,
          isTop: window.top === window,
          above: (function () { try { return String(parent.document) } catch (e) { return 'refused' } })(),
          rtc: typeof RTCPeerConnection, wasm: typeof WebAssembly, audio: typeof AudioContext,
          gl: (function () { try { return !!document.createElement('canvas').getContext('webgl') } catch (e) { return false } })(),
          canvas: !!document.createElement('canvas').getContext('2d'),
        })
        """)
        let got = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(has.utf8)) as? [String: Any])
        XCTAssertEqual(got["handlers"] as? String, "undefined", "none of the app's message handlers")
        XCTAssertEqual(got["cookie"] as? String, "")
        XCTAssertEqual(got["storage"] as? String, "refused")
        XCTAssertEqual(got["origin"] as? String, "null")
        XCTAssertEqual(got["isTop"] as? Bool, false)
        XCTAssertEqual(got["above"] as? String, "refused", "the page above it is out of reach")
        // what Lockdown Mode takes from a card's script, so the card prompt can say so
        XCTAssertEqual(got["rtc"] as? String, "undefined")
        XCTAssertEqual(got["wasm"] as? String, "undefined")
        XCTAssertEqual(got["audio"] as? String, "undefined")
        XCTAssertEqual(got["gl"] as? Bool, false)
        XCTAssertEqual(got["canvas"] as? Bool, true, "a 2D canvas still draws")
    }

    // MARK: the time limit, and nothing left running

    func testAScriptThatNeverReturnsIsStoppedAtTheLimitAndItsProcessEnds() async throws {
        let loops = [
            "in a frame": "function kitFrame() { while (true) {} }",
            "as the page loads": "while (true) {}\nfunction kitFrame() {}",
            "in a later frame": "function kitFrame(t) { document.getElementById('stage').textContent = t; if (t > 0.4) while (true) {} }",
            "in a timer of its own": "setTimeout(function () { while (true) {} }, 200);\nfunction kitFrame(t) { document.getElementById('stage').textContent = t; }",
        ]
        for (name, kit) in loops {
            let page = try KitWebView(width: 320, height: 180)
            let look = Task { @MainActor () -> pid_t in
                try? await Task.sleep(nanoseconds: 600_000_000)
                return page.processID
            }
            let started = Date()
            do {
                // 60 frames, so a script that loops in a timer of its own is met before the card is through
                try await KitRunner.draw(KitCard(kit: kit, width: 320, height: 180, seconds: 15, fps: 4, content: [:]), on: page, limit: 1.5) { _, _ in
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                XCTFail("a script that loops \(name) drew a card")
            } catch {
                XCTAssertEqual(error as? KitRunnerError, .timedOut, name)
            }
            XCTAssertLessThan(Date().timeIntervalSince(started), 4, "the limit ends the card \(name)")
            let pid = await look.value
            XCTAssertGreaterThan(pid, 0, "the page had a process (\(name))")
            let ended = await gone(pid)
            XCTAssertTrue(ended, "the page's process is gone, not left looping (\(name))")
        }
        // and the next card draws as if nothing had happened
        var frames = 0
        try await KitRunner.draw(card("function kitFrame(t) { document.getElementById('stage').textContent = t; }")) { _, _ in frames += 1 }
        XCTAssertEqual(frames, 4)
    }

    func testEveryCardsPageHasAProcessOfItsOwnThatEndsWithIt() async throws {
        let one = try await shutIn("function kitFrame() {}")
        let two = try await shutIn("function kitFrame() {}")
        let (a, b) = (one.processID, two.processID)
        XCTAssertTrue(KitWebView.isPageProcess(a))
        XCTAssertTrue(KitWebView.isPageProcess(b))
        XCTAssertNotEqual(a, b, "ending one card's page can never end another's")
        // only a WebKit page process is ever ended: not this program, not the system's first process, not nothing
        XCTAssertFalse(KitWebView.isPageProcess(getpid()))
        XCTAssertFalse(KitWebView.isPageProcess(1))
        XCTAssertFalse(KitWebView.isPageProcess(0))
        one.end()
        let first = await gone(a)
        XCTAssertTrue(first)
        XCTAssertTrue(KitWebView.isPageProcess(b), "the other card's page is untouched")
        try await two.paint(at: 0)
        two.end()
        let second = await gone(b)
        XCTAssertTrue(second)
    }

    func testAFinishedCardLeavesNoProcess() async throws {
        let page = try KitWebView(width: 320, height: 180)
        var pid: pid_t = 0
        try await KitRunner.draw(card("function kitFrame(t) { document.getElementById('stage').textContent = t; }"), on: page, limit: KitRunner.cardLimit) { _, _ in
            pid = page.processID
        }
        XCTAssertGreaterThan(pid, 0)
        let ended = await gone(pid)
        XCTAssertTrue(ended)
    }

    func testTheWallsAreThisPagesAlone() async throws {
        // a card's page switches WebKit's link preconnect off for itself: a web view made afterwards still has it
        let site = FakeSite()
        _ = try await shutIn("function kitFrame() {}")
        let other = try await open("const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'http://127.0.0.1:\(site.port)'; document.head.appendChild(l);\nfunction kitFrame() {}")
        await pause(1.5)
        XCTAssertGreaterThan(site.connections, 0)
        other.end()
    }
}
