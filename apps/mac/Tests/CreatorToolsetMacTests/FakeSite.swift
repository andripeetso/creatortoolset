import Foundation

/// A stand-in for the person's server, for tests: real HTTP on 127.0.0.1 only (so macOS never asks about incoming
/// connections), answered from `answer`, with every request remembered. Also counts every connection made to it,
/// since a page can reach out without sending a request.
final class FakeSite: @unchecked Sendable {
    struct Request {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    let port: UInt16
    var url: URL { URL(string: "http://127.0.0.1:\(port)")! }
    private let fd: Int32
    private let lock = NSLock()
    private var got: [Request] = []
    private var accepted = 0
    private var reply: (Request) -> (Int, String) = { _ in (200, "{}") }
    private var raw: (Request) -> Data? = { _ in nil }

    init() {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        self.fd = fd
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        port = UInt16(bigEndian: addr.sin_port)
        listen(fd, 64)
        Thread { [self] in
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { break }
                lock.lock(); accepted += 1; lock.unlock()
                Thread { [self] in serve(c) }.start()
            }
        }.start()
    }

    deinit { close(fd) }

    /// Every HTTP request so far, in the order they arrived.
    var requests: [Request] { lock.lock(); defer { lock.unlock() }; return got }
    /// Every connection made so far, with a request or without.
    var connections: Int { lock.lock(); defer { lock.unlock() }; return accepted }
    /// How each request is answered: a status and a JSON body.
    var answer: (Request) -> (Int, String) {
        get { lock.lock(); defer { lock.unlock() }; return reply }
        set { lock.lock(); reply = newValue; lock.unlock() }
    }
    /// A body that is not text (a picture) for the requests it gives one for, sent in place of `answer`'s, with its status.
    var bytes: (Request) -> Data? {
        get { lock.lock(); defer { lock.unlock() }; return raw }
        set { lock.lock(); raw = newValue; lock.unlock() }
    }
    func forget() { lock.lock(); got = []; accepted = 0; lock.unlock() }

    private func serve(_ c: Int32) {
        defer { close(c) }
        var yes: Int32 = 1
        setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        var wait = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 65536)
        let end = Data("\r\n\r\n".utf8)
        var head: Range<Data.Index>?
        while head == nil, data.count < 1_000_000 {
            let n = recv(c, &buf, buf.count, 0)
            if n <= 0 { break }
            data.append(buf, count: n)
            head = data.range(of: end)
        }
        guard let head, let lines = Optional(String(decoding: data[..<head.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")),
              let first = lines.first?.split(separator: " "), first.count == 3, first[2].hasPrefix("HTTP/") else { return }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        var body = Data(data[head.upperBound...])
        let length = Int(headers["content-length"] ?? "") ?? 0
        while body.count < length {
            let n = recv(c, &buf, buf.count, 0)
            if n <= 0 { break }
            body.append(buf, count: n)
        }
        let request = Request(method: String(first[0]), path: String(first[1]), headers: headers, body: body)
        lock.lock()
        got.append(request)
        let respond = reply
        let picture = raw
        lock.unlock()
        let (status, json) = respond(request)
        let answered = picture(request) ?? Data(json.utf8)
        let out = Data("HTTP/1.1 \(status) -\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: \(answered.count)\r\nConnection: close\r\n\r\n".utf8) + answered
        out.withUnsafeBytes { _ = send(c, $0.baseAddress, out.count, 0) }
    }
}

/// Counts the UDP packets that reach a port on 127.0.0.1 (what a page's WebRTC sends a STUN server).
final class PacketCounter: @unchecked Sendable {
    let port: UInt16
    private let fd: Int32
    private let lock = NSLock()
    private var seen = 0

    init() {
        let fd = socket(AF_INET, SOCK_DGRAM, 0)
        self.fd = fd
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        port = UInt16(bigEndian: addr.sin_port)
        Thread { [self] in
            var buf = [UInt8](repeating: 0, count: 2048)
            while recv(fd, &buf, buf.count, 0) > 0 {
                lock.lock(); seen += 1; lock.unlock()
            }
        }.start()
    }

    deinit { close(fd) }

    var packets: Int { lock.lock(); defer { lock.unlock() }; return seen }
}

/// A folder for one test's files: under TMPDIR when the run sets one (the system's own temporary folder ignores it).
func testFolder(_ name: String) -> URL {
    let root = ProcessInfo.processInfo.environment["TMPDIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
    let dir = root.appendingPathComponent("\(name)-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// One file of a multipart/form-data body, as a server reads it.
struct ReadPart {
    let name: String
    let filename: String
    let type: String
    let data: Data
}

/// The files of a multipart/form-data body. The tests' own reading; `report/` holds the same body read by Node's parser.
func readMultipart(_ body: Data, contentType: String) -> [ReadPart] {
    guard let at = contentType.range(of: "boundary=") else { return [] }
    let mark = Data("--\(contentType[at.upperBound...])".utf8)
    var parts: [ReadPart] = []
    var from = body.startIndex
    var starts: [Data.Index] = []
    while let hit = body.range(of: mark, in: from..<body.endIndex) {
        starts.append(hit.upperBound)
        from = hit.upperBound
    }
    for (begin, next) in zip(starts, starts.dropFirst()) {
        // "\r\n" + headers + "\r\n\r\n" + data + "\r\n" + the next mark
        let piece = body[begin..<(next - mark.count)]
        guard let gap = piece.range(of: Data("\r\n\r\n".utf8)) else { continue }
        let head = String(decoding: piece[piece.startIndex..<gap.lowerBound], as: UTF8.self)
        let field = { (key: String) -> String in
            guard let k = head.range(of: "\(key)=\"") else { return "" }
            return String(head[k.upperBound...].prefix { $0 != "\"" })
        }
        let type = head.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("content-type:") }?
            .dropFirst("content-type:".count).trimmingCharacters(in: .whitespaces) ?? ""
        parts.append(ReadPart(name: field("name"), filename: field("filename"), type: type, data: Data(piece[gap.upperBound..<(piece.endIndex - 2)])))
    }
    return parts
}
