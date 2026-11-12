#if DEBUG
import UIKit

/// Conversations a debug build can show instead of the server's, to look at a state without
/// taps: `-AssistantFixture none|empty|thinking|failed|asks|long|lists`. While one is shown nothing is written
/// to the server and nothing is saved. With one, `-AssistantQueue <text>` adds a queued message
/// and `-AssistantNotSent <text>` one the server refused.
enum AssistantFixtures {
    static let current: String? = {
        switch debugArg("AssistantFixture") {
        case "none": noAI
        case "empty": newChat
        case "thinking": replying
        case "failed": failedReply
        case "asks": asks
        case "long": longReply
        case "lists": listsReply
        default: nil
        }
    }()

    /// What waits in the queue of a shown conversation.
    static var queued: [QueuedMessage] {
        guard current != nil else { return [] }
        return (debugArg("AssistantQueue").map { [QueuedMessage(text: $0)] } ?? [])
            + (debugArg("AssistantNotSent").map { [QueuedMessage(text: $0, failed: "A video didn't finish uploading: add it again")] } ?? [])
    }

    private static func picture(_ color: UIColor, _ number: Int) -> QueuedMessage.Picture {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 200)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
        }
        return .init(name: "Photo \(number).jpg", jpeg: image.jpegData(compressionQuality: 0.8) ?? Data())
    }

    private static var acted = false

    /// `-AssistantDo allow,stop,new,picture,video,say:<words>` (in that order, any of them): runs what
    /// the buttons run, once the conversation is read, to check the real calls without taps. Unlike
    /// the fixtures these DO write to the server. `video:<bytes>` uploads that many made-up bytes as a clip.
    @MainActor static func act(_ model: AssistantModel) async {
        guard current == nil, !acted, let script = debugArg("AssistantDo") else { return }
        acted = true
        for step in script.components(separatedBy: ",") {
            switch step {
            case "allow":
                let waiting = model.view?.messages.flatMap { $0.approvals ?? [] }.first { $0.status == "waiting" }
                if let waiting { await model.answer(approval: waiting.id, allow: true) }
            case "stop":
                // after a `say`: the message is on its way, so wait until its reply is being written
                for _ in 0..<60 where model.view?.thinking == nil { try? await Task.sleep(for: .milliseconds(100)) }
                await model.stop()
            case "new":
                await model.newChat()
            case "picture":
                model.draft.pretend(pictures: [picture(.systemTeal, 1)], videos: model.draft.videos)
            default:
                if step.hasPrefix("video:"), let bytes = Int(step.dropFirst(6)) {
                    let folder = AssistantPickedVideo.folder.appendingPathComponent("check", isDirectory: true)
                    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let clip = folder.appendingPathComponent("Phone clip.mp4")
                    try? Data(repeating: 7, count: bytes).write(to: clip)
                    model.draft.pretendPicked(clip)
                    for _ in 0..<300 where model.draft.videos.contains(where: { $0.fileID == nil && $0.error == nil }) {
                        try? await Task.sleep(for: .milliseconds(200))
                    }
                }
                guard step.hasPrefix("say:") else { continue }
                model.draft.text = String(step.dropFirst(4))
                if let message = model.draft.take() { model.send(message) }
            }
        }
    }

    /// `-AssistantDraft YES`: two pictures and a video half way up in the message box;
    /// `-AssistantDraft failed`: a video that did not upload.
    @MainActor static func fill(_ draft: AssistantDraft) {
        guard let kind = debugArg("AssistantDraft"), !draft.hasAttachment else { return }
        if kind == "failed" {
            draft.pretend(pictures: [], videos: [.init(name: "IMG_2042.MOV", progress: 0.7, error: "No answer from the server")])
            return
        }
        let pictures = [picture(.systemTeal, 1), picture(.systemOrange, 2)]
        draft.pretend(pictures: pictures, videos: [
            .init(name: "IMG_2041.MOV", progress: 0.4),
            .init(name: "IMG_2042.MOV", progress: 1, fileID: "done"),
        ])
        draft.text = "Caption these and put the clip in Review"
    }

    private static let noAI = #"""
    {"id":"3441cbd5-c2c7-4ca9-b10f-1cddb2cad321","provider":"none","aiName":"","tools":false,"messages":[],"past":[],"pending":null,"navigate":null}
    """#

    // the server's answer to a new chat (DELETE /api/assistant)
    private static let newChat = #"""
    {"id":"c16cd755-fc42-4f7a-bed1-0cd14c0d0825","provider":"claude","aiName":"Claude Code","tools":true,"messages":[],
     "past":[{"id":"f8df3b11-9478-4efe-8992-3505d954a1f7","title":"What is waiting on me today?","at":1794417464050,"count":7},
             {"id":"7a97d6ec-2ade-437c-a75f-0ee7e2cd384a","title":"Write three hooks for a reel about carrying positions.","at":1794323917248,"count":2},
             {"id":"fec1d3fa-b87d-4114-aaa1-0f16dcfaea1e","title":"Monday numbers","at":1794158377251,"count":3}],
     "pending":null,"navigate":null}
    """#

    // a reply being written, as it is live: steps so far, and a thing it asks to do on the Mac
    private static let replying = #"""
    {"id":"3441cbd5-c2c7-4ca9-b10f-1cddb2cad321","provider":"claude","aiName":"Claude Code","tools":true,
     "messages":[
      {"id":"1d874921-06b7-429c-8c19-3f695203c2d2","role":"user","text":"Clear out the old renders on my Mac, keep this week's.","at":\#(Int(Date().timeIntervalSince1970 * 1000) - 42_000),"quote":"Exports: 41 GB","pasted":["render-list.txt"]},
      {"id":"fb911d9a-4db1-45fd-b3f7-a1d3a713ecf9","role":"assistant","text":"I listed the folder. Three renders are older than a week (11.2 GB).","at":\#(Int(Date().timeIntervalSince1970 * 1000) - 41_000),"status":"thinking",
       "steps":["Reading files","Running a command"],
       "approvals":[
        {"id":"49c96110-9d2f-4f67-9e3e-fef7e77d48a1","tool":"Bash","summary":"Run a command: List the exports folder","detail":"ls -la ~/Movies/Exports","at":1794417164693,"status":"allowed"},
        {"id":"cdbac339-d47a-425e-8ed7-baed97c011de","tool":"Bash","summary":"Run a command: Delete three renders older than a week","detail":"rm ~/Movies/Exports/tummy-v1.mov ~/Movies/Exports/tummy-v2.mov ~/Movies/Exports/hanging-test.mov","at":1794417464689,"status":"waiting"}]}],
     "past":[],"pending":null,"navigate":null}
    """#

    // hand-made (no server answer captured yet): a reply with the Yes / No questions of a newer server, and one
    // more reply the server added when the work ended, with answers to press
    private static let asks = #"""
    {"id":"c1","provider":"claude","aiName":"Claude Code","tools":true,
     "messages":[
      {"id":"m1","role":"user","text":"Tidy up my scheduled tasks and post the Sleep routine reel.","at":1794158377251},
      {"id":"m2","role":"assistant","text":"Two of them never run any more, and the reel is ready:","at":1794158378251,"status":"done",
       "steps":["Looking at your scheduled tasks","Looking through Review"],
       "work":[{"id":"edit:e1:music","kind":"edit","title":"Sleep routine reel","href":"/editor/e1","status":"done","detail":"Music is in"}],
       "confirms":[
        {"id":"q1","question":"Delete the scheduled task “Old weekly numbers”?","at":1794158378300,"status":"done"},
        {"id":"q2","question":"Delete the scheduled task “Test run”?","at":1794158378400,"status":"no"},
        {"id":"q3","question":"Send the Sleep routine reel to the client?","at":1794158378500,"status":"failed","result":"The share link is switched off for this video."},
        {"id":"q4","question":"Delete the scheduled task “Monday comments”?","at":1794158378600,"status":"waiting"}]},
      {"id":"m3","role":"assistant","text":"The music pass on **Sleep routine reel** is finished.","at":1794158379251,"status":"done",
       "choices":["Show me the cut","Post it"]}],
     "past":[],"pending":null,"navigate":null}
    """#

    // a reply that failed (the seeded earlier chat "Monday numbers" ends this way)
    private static let failedReply = #"""
    {"id":"ea83ec28-66dc-4ad0-9792-e8bb687a5cf9","provider":"claude","aiName":"Claude Code","tools":true,
     "messages":[
      {"id":"m1","role":"user","text":"How did last week's posts do?","at":1794158377251},
      {"id":"m2","role":"assistant","text":"The answer failed: the Mac did not answer in time.","at":1794158378251,"status":"error"}],
     "past":[],"pending":null,"navigate":null}
    """#
}
#endif
