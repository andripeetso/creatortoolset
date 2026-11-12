import AVKit
import PhotosUI
import SwiftUI

/// Caption Studio's projects: open one, or start one from a video in Photos.
struct CaptionStudioView: View {
    @StateObject private var model = CaptionProjects()
    @State private var item: PhotosPickerItem?
    @State private var opened: String?
    @State private var importing = false
    @State private var importError: String?
    @State private var launched = false

    var body: some View {
        List {
            if model.needsSignIn {
                SignInAgainButton { await model.load() }.listRowSeparator(.hidden)
            } else if let error = importError ?? model.error {
                Problem(text: error)
            }
            Section {
                PhotosPicker(selection: $item, matching: .videos, preferredItemEncoding: .current) {
                    HStack {
                        Label("New from a video", systemImage: "plus.circle.fill")
                        Spacer()
                        if importing { ProgressView() }
                    }
                }
                .disabled(importing)
            }
            if model.loading { ProgressView().frame(maxWidth: .infinity) }
            if !model.projects.isEmpty {
                Section {
                    ForEach(model.projects) { project in
                        Button { opened = project.id } label: { CaptionProjectRow(project: project) }
                            .buttonStyle(.plain)
                    }
                } header: {
                    Text("Projects")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Caption Studio")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task {
            await model.load()
            guard !launched else { return }
            launched = true
            if let id = debugArg("Open") { opened = id }
            if let path = debugArg("NewFrom") { opened = CaptionEditor.new(URL(fileURLWithPath: path)).id }
        }
        .onChange(of: item) { _, picked in
            guard let picked else { return }
            item = nil
            Task { await start(picked) }
        }
        .navigationDestination(item: $opened) { CaptionEditorView(editor: CaptionEditor.project($0)) }
    }

    private func start(_ picked: PhotosPickerItem) async {
        importing = true
        importError = nil
        defer { importing = false }
        do {
            guard let video = try await picked.loadTransferable(type: CaptionPickedVideo.self) else {
                throw CocoaError(.fileReadUnknown)
            }
            opened = CaptionEditor.new(video.url).id
        } catch {
            importError = "Couldn't open this video. \(error.localizedDescription)"
        }
    }
}

private struct CaptionProjectRow: View {
    let project: CapProjectSummary

    var body: some View {
        HStack(spacing: 12) {
            ToolsetImage(path: project.thumb, maxPixels: 240)
                .frame(width: 48, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 3) {
                Text(project.name).font(.subheadline.weight(.medium)).lineLimit(2)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    private var detail: String {
        let when = Date(timeIntervalSince1970: project.updatedAt / 1000).formatted(.relative(presentation: .named))
        let clips = project.clipCount == 1 ? "" : " · \(project.clipCount) clips"
        return (project.duration ?? 0) > 0 ? "\(clock(project.duration ?? 0)) · \(when)\(clips)" : when + clips
    }
}

/// The picked video, copied out of the picker's short-lived file.
private struct CaptionPickedVideo: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appending(path: "caption-sources/\(UUID().uuidString)", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appending(path: received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return CaptionPickedVideo(url: copy)
        }
    }
}

// MARK: The editor

struct CaptionEditorView: View {
    @ObservedObject var editor: CaptionEditor
    @ObservedObject private var access = ToolsetAccess.shared
    @State private var panel = debugArg("Panel") == "style" ? Panel.style : .captions
    @State private var editingText = false

    enum Panel: String, CaseIterable {
        case captions = "Captions", style = "Style"
    }

    var body: some View {
        VStack(spacing: 0) {
            player
            status
            Picker("Panel", selection: $panel) {
                ForEach(Panel.allCases, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)
            switch panel {
            case .captions: captionList
            case .style: CaptionStylePanel(editor: editor)
            }
        }
        .navigationTitle(editor.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button("Edit the text", systemImage: "text.cursor") { editingText = true }
                        .disabled(editor.cues.isEmpty || editor.busy)
                    Button("Match cadence again", systemImage: "waveform") { Task { await editor.rematch() } }
                        .disabled(editor.cues.isEmpty || editor.busy)
                    if editor.clips.count > 1 {
                        Picker("Clip", selection: Binding(get: { editor.clip?.id ?? "" }, set: { id in
                            if let next = editor.clips.first(where: { $0.id == id }) { Task { await editor.show(next) } }
                        })) {
                            ForEach(editor.clips) { Text($0.name).tag($0.id) }
                        }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                Menu {
                    Button("Save to Photos", systemImage: "square.and.arrow.down") {
                        Task { await editor.export(toFinals: false) }
                    }
                    if access.me?.role == "admin" {
                        Button("Send to Finals", systemImage: "rectangle.stack") { Task { await editor.export(toFinals: true) } }
                    }
                } label: { Image(systemName: "square.and.arrow.up") }
                .disabled(editor.cues.isEmpty || editor.busy)
            }
        }
        .sheet(isPresented: $editingText) {
            TranscriptEditor(text: editor.transcript) { text in Task { await editor.edit(text) } }
        }
        .onDisappear {
            editor.player?.pause()
            Task { await editor.save() }
        }
        #if DEBUG
        // simulator checks without taps: -Preset Classic [-Lines 2] [-SavePreset Mine]
        .task {
            guard let name = debugArg("Preset") else { return }
            while editor.clip?.cues?.isEmpty ?? true { try? await Task.sleep(for: .milliseconds(300)) }
            if let preset = editor.presets.first(where: { $0.name == name }) { editor.choose(preset) }
            if let n = debugArg("Lines").flatMap(Int.init) {
                try? await Task.sleep(for: .seconds(1))
                editor.restyle(relayout: true) { $0.lines = n }
            }
            if let saved = debugArg("SavePreset") {
                try? await Task.sleep(for: .seconds(2))
                await editor.savePreset(saved)
            }
        }
        #endif
    }

    /// The iPhone's own player with the captions on it (full screen too).
    private var player: some View {
        ZStack {
            Color.black
            if let player = editor.player {
                NativePlayer(player: player) { CaptionOverlay(editor: editor, clock: editor.clock) }
            }
        }
        .frame(maxWidth: .infinity)
        .containerRelativeFrame(.vertical) { height, _ in height * (debugArg("PlayerHeight").flatMap(Double.init) ?? 0.46) }
    }

    @ViewBuilder private var status: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let text = editor.exporting ?? editor.step?.label {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(text).font(.footnote)
                }
            }
            if let fraction = editor.uploading {
                ProgressView(value: fraction) {
                    Text("Uploading the video \(Int(fraction * 100))%").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error = editor.error {
                Problem(text: error).onTapGesture { editor.error = nil }
                if editor.canRetryUpload {
                    Button("Try the upload again") { Task { await editor.upload() } }.font(.footnote)
                }
            }
            if let notice = editor.notice {
                Text(notice).font(.footnote).foregroundStyle(.secondary)
                    .onTapGesture { editor.notice = nil }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        .padding(.top, 8)
    }

    private var captionList: some View {
        List {
            if editor.cues.isEmpty, editor.clip != nil, !editor.busy {
                Button("Transcribe this clip", systemImage: "waveform") { Task { await editor.transcribe() } }
            }
            ForEach(editor.cues) { cue in
                CueRow(cue: cue, playhead: editor.clock) {
                    editor.player?.seek(to: CMTime(seconds: cue.start + 0.01, preferredTimescale: 600),
                                        toleranceBefore: .zero, toleranceAfter: .zero)
                }
            }
        }
        .listStyle(.plain)
    }
}

/// Every control the website's Caption style panel has (StylePanel.tsx),
/// plus lines per caption, which the web sets through the box height.
private struct CaptionStylePanel: View {
    @ObservedObject var editor: CaptionEditor
    @ObservedObject private var fonts = CaptionFonts.shared
    @ObservedObject private var access = ToolsetAccess.shared
    @State private var naming = false
    @State private var presetName = ""

    /// FONT_OPTIONS in apps/captions/src/lib/types.ts.
    private static let fontOptions: [(label: String, family: String)] = [
        ("Anton", "Anton"), ("Archivo Black", "Archivo Black"), ("Bebas Neue", "Bebas Neue"),
        ("Inter Bold", "Inter"), ("Inter ExtraBold", "Inter ExtraBold"),
        ("Montserrat SemiBold", "Montserrat SemiBold"), ("Montserrat Bold", "Montserrat"),
        ("Montserrat ExtraBold", "Montserrat ExtraBold"), ("Oswald SemiBold", "Oswald SemiBold"),
        ("Oswald Bold", "Oswald"), ("Poppins Bold", "Poppins"),
    ]

    var body: some View {
        if let style = editor.clip?.style {
            Form {
                Section("Presets") { presets(style) }
                Section("Layout") {
                    LabeledContent("Lines") {
                        Picker("Lines", selection: Binding(get: { style.lines }, set: { n in
                            editor.restyle(relayout: true) { $0.lines = n }
                        })) {
                            ForEach(1...4, id: \.self) { Text("\($0)").tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 200)
                    }
                    slider("Size", "\(Int((style.fontSizePct / 100 * editor.frame.height).rounded())) px",
                           style.fontSizePct, 1.5...10, step: 0.1, relayout: true) { $0.resize($1) }
                    slider("Width", "\(Int(style.boxW.rounded()))%", style.boxW, 15...100, step: 1, relayout: true) {
                        $0.boxW = $1
                        $0.boxX = min(max($0.boxX, $1 / 2), 100 - $1 / 2)
                    }
                    if style.boxH < 98 {
                        slider("Height on the video", "\(Int(style.boxY.rounded()))%", style.boxY,
                               style.boxH / 2...100 - style.boxH / 2, step: 0.5) { $0.boxY = $1 }
                    }
                    if style.boxW < 98 {
                        slider("Across", "\(Int(style.boxX.rounded()))%", style.boxX,
                               style.boxW / 2...100 - style.boxW / 2, step: 0.5) { $0.boxX = $1 }
                        Button("Centre across") { editor.restyle { $0.boxX = 50 } }
                            .disabled(style.boxX == 50)
                    }
                }
                Section("Text") {
                    fontsRow(style)
                    Picker("Case", selection: Binding(get: { style.flag("uppercase") ? 1 : style.flag("lowercase") ? 2 : 0 },
                                                      set: { c in editor.restyle {
                                                          $0.set("uppercase", c == 1)
                                                          $0.set("lowercase", c == 2)
                                                      } })) {
                        Text("As spoken").tag(0)
                        Text("UPPER").tag(1)
                        Text("lower").tag(2)
                    }
                    .pickerStyle(.segmented)
                    color("Text colour", "textColor", style)
                    Picker("Animation", selection: Binding(get: { style.animation },
                                                           set: { a in editor.restyle { $0.animation = a } })) {
                        Text("None").tag("none")
                        Text("Karaoke word highlight").tag("karaoke")
                        Text("Pop in").tag("pop")
                        Text("Fade").tag("fade")
                    }
                    if style.karaoke { color("Highlight", "highlightColor", style) }
                }
                Section {
                    Toggle("Background box", isOn: Binding(get: { style.boxEnabled },
                                                           set: { on in editor.restyle { $0.set("boxEnabled", on) } }))
                    if style.boxEnabled {
                        color("Box colour", "boxColor", style)
                        slider("Opacity", "\(Int((style.number("boxOpacity", 1) * 100).rounded()))%",
                               style.number("boxOpacity", 1), 0.1...1, step: 0.05) { $0.set("boxOpacity", $1) }
                    } else {
                        Toggle("Outline", isOn: Binding(get: { style.outlineWidth > 0 },
                                                        set: { on in editor.restyle { $0.set("outlineWidth", on ? 4.0 : 0.0) } }))
                        if style.outlineWidth > 0 {
                            color("Outline colour", "outlineColor", style)
                            slider("Outline width", String(format: "%.1f", style.outlineWidth), style.outlineWidth,
                                   0.5...12, step: 0.5) { $0.set("outlineWidth", $1) }
                        }
                        slider("Shadow", String(format: "%.1f", style.shadowDepth), style.shadowDepth,
                               0...8, step: 0.5) { $0.set("shadowDepth", $1) }
                    }
                } header: {
                    Text("Box and outline")
                } footer: {
                    Text("A box and an outline don't go together: with the box on, the text has none (as on the website).")
                }
            }
            .task { await fonts.loadAll() }
            .alert("Save as a preset", isPresented: $naming) {
                TextField("Name", text: $presetName)
                Button("Save") { Task { await editor.savePreset(presetName) } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(access.me?.role == "admin" ? "Everyone gets it, on the website too. The same name again replaces it."
                     : "It's yours, on the website too. The same name again replaces it.")
            }
        }
    }

    private func presets(_ style: CapStyle) -> some View {
        ScrollViewReader { row in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(editor.presets, id: \.self) { preset in
                        let chosen = preset.style.values == style.values
                        Button { editor.choose(preset) } label: {
                            HStack(spacing: 6) {
                                Text("Aa").font(Font(fonts.font(preset.style.fontFamily, size: 15)))
                                Text(preset.name).font(.subheadline)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(chosen ? Color("AccentColor").opacity(0.25) : Color(.tertiarySystemFill), in: Capsule())
                            .overlay { if chosen { Capsule().strokeBorder(Color("AccentColor"), lineWidth: 1.5) } }
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            if deletable(preset) {
                                Button("Delete “\(preset.name)”", systemImage: "trash", role: .destructive) {
                                    Task { await editor.deletePreset(preset) }
                                }
                            }
                        }
                    }
                    Button {
                        presetName = ""
                        naming = true
                    } label: {
                        Label("Save", systemImage: "plus").font(.subheadline)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .overlay { Capsule().strokeBorder(.secondary, style: StrokeStyle(lineWidth: 1, dash: [4])) }
                    }
                    .buttonStyle(.plain)
                }
                .padding(.vertical, 2)
            }
            .onAppear {
                if let chosen = editor.presets.first(where: { $0.style.values == style.values }) {
                    row.scrollTo(chosen, anchor: .center)
                }
            }
        }
    }

    /// The web's rule: an admin may delete any saved preset, anyone else their own.
    private func deletable(_ preset: CapPreset) -> Bool {
        guard preset.id != nil, let me = access.me else { return false }
        return me.role == "admin" || preset.owner == me.username
    }

    /// Each font shown in itself.
    private func fontsRow(_ style: CapStyle) -> some View {
        ScrollViewReader { row in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Self.fontOptions, id: \.family) { option in
                        let chosen = option.family == style.fontFamily
                        Button {
                            editor.restyle { $0.fontFamily = option.family }
                            Task { await fonts.load(option.family) }
                        } label: {
                            VStack(spacing: 2) {
                                Text("Aa").font(Font(fonts.font(option.family, size: 24)))
                                Text(option.label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            .frame(width: 92, height: 58)
                            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                            .overlay {
                                if chosen { RoundedRectangle(cornerRadius: 10).strokeBorder(Color("AccentColor"), lineWidth: 2) }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }
            .onAppear { row.scrollTo(style.fontFamily, anchor: .center) }
        }
    }

    private func color(_ title: String, _ key: String, _ style: CapStyle) -> some View {
        ColorPicker(title, selection: Binding(get: { hexColor(style.text(key, "#FFFFFF")) },
                                              set: { c in editor.restyle { $0.set(key, hexString(c)) } }),
                    supportsOpacity: false)
    }

    /// A slider with its value; `relayout` ones lay the captions out again once let go.
    private func slider(_ title: String, _ shown: String, _ value: Double, _ range: ClosedRange<Double>,
                        step: Double, relayout: Bool = false,
                        _ change: @escaping (inout CapStyle, Double) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title)
                Spacer()
                Text(shown).foregroundStyle(.secondary).monospacedDigit()
            }
            // rounded here, not `step:`: a stepped slider draws a tick per step
            Slider(value: Binding(get: { min(max(value, range.lowerBound), range.upperBound) },
                                  set: { v in editor.restyle { change(&$0, (v / step).rounded() * step) } }),
                   in: range) {
                Text(title)
            } onEditingChanged: { moving in
                if relayout, !moving { editor.relayout() }
            }
        }
    }
}

private struct CueRow: View {
    let cue: CapCue
    @ObservedObject var playhead: CaptionClock
    let seek: () -> Void

    var body: some View {
        Button(action: seek) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(clock(cue.start)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Text(cue.text).font(.subheadline).foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(playhead.time >= cue.start && playhead.time < cue.end ? Color("AccentColor").opacity(0.18) : nil)
    }
}

/// The captions over the video, drawn like the website's render surface
/// (src/components/CaptionRenderSurface.tsx): the box centred on the style's
/// box, one rounded background around all lines, or an outline ring.
private struct CaptionOverlay: View {
    @ObservedObject var editor: CaptionEditor
    @ObservedObject var clock: CaptionClock
    @ObservedObject private var fonts = CaptionFonts.shared

    var body: some View {
        GeometryReader { geo in
            let rect = AVMakeRect(aspectRatio: editor.frame, insideRect: CGRect(origin: .zero, size: geo.size))
            if let style = editor.clip?.style, rect.height > 0, let cue = editor.cue(at: clock.time) {
                CaptionBlock(cue: cue, style: style, time: clock.time,
                             maxChars: style.maxChars(width: editor.frame.width, height: editor.frame.height),
                             font: fonts.font(style.fontFamily, size: style.fontSizePct / 100 * rect.height),
                             scale: rect.height / 1080)
                    .position(x: rect.minX + style.boxX / 100 * rect.width, y: rect.minY + style.boxY / 100 * rect.height)
            }
        }
        .allowsHitTesting(false)
    }
}

private struct CaptionBlock: View {
    let cue: CapCue
    let style: CapStyle
    let time: Double
    let maxChars: Int
    let font: UIFont
    let scale: Double

    var body: some View {
        let px = font.pointSize
        VStack(spacing: 0) {
            ForEach(Array(cue.lineWords(maxChars: maxChars).enumerated()), id: \.offset) { _, line in
                lineView(line).frame(height: px * 1.18)
            }
        }
        .padding(.vertical, style.boxEnabled ? px * 0.12 : 0)
        .padding(.horizontal, style.boxEnabled ? px * 0.28 : 0)
        .background {
            if style.boxEnabled { RoundedRectangle(cornerRadius: px * 0.18).fill(style.boxColor) }
        }
        .fixedSize()
        .scaleEffect(pop)
        .opacity(fade)
    }

    /// The web's entrance animations, sampled from the caption's age like
    /// its export: pop 0.55 → 1.12 → 1 over 0.28 s, fade in over 0.3 s.
    private var pop: Double {
        let p = (time - cue.start) / 0.28
        guard style.animation == "pop", p < 1 else { return 1 }
        return p < 0.55 ? 0.55 + 0.57 * max(0, p) / 0.55 : 1.12 - 0.12 * (p - 0.55) / 0.45
    }

    private var fade: Double {
        style.animation == "fade" ? min(1, max(0, (time - cue.start) / 0.3)) : 1
    }

    @ViewBuilder private func lineView(_ words: [CapWord]) -> some View {
        let ring = style.boxEnabled ? 0 : style.outlineWidth * scale
        let depth = style.boxEnabled ? 0 : style.shadowDepth * scale
        ZStack {
            if ring > 0 {
                ForEach(0..<16, id: \.self) { i in
                    let a = Double(i) / 16 * 2 * .pi
                    text(words, outline: true).offset(x: cos(a) * ring, y: sin(a) * ring)
                }
            }
            text(words, outline: false)
        }
        .shadow(color: depth > 0 ? .black.opacity(0.55) : .clear, radius: 1, x: depth, y: depth)
        .fixedSize()
    }

    private func text(_ words: [CapWord], outline: Bool) -> Text {
        words.enumerated().reduce(Text("")) { line, item in
            let color = outline ? style.outlineColor
                : style.karaoke && time >= item.element.start ? style.highlightColor : style.textColor
            return line + Text((item.offset > 0 ? " " : "") + style.cased(item.element.text)).foregroundStyle(color)
        }
        .font(Font(font))
        .tracking(font.pointSize * 0.01)
    }
}

/// The captions as text, one per line: fix a word by typing over it (the
/// timing follows), move a line break to regroup.
private struct TranscriptEditor: View {
    @State var text: String
    let done: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .font(.body)
                .padding(.horizontal)
                .safeAreaInset(edge: .top) {
                    Text("One caption per line. Type over a word to fix it; its timing stays.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                }
                .navigationTitle("Captions")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            done(text)
                            dismiss()
                        }
                    }
                }
        }
    }
}
