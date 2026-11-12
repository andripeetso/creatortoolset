import Photos

/// Files into the iPhone's Photos (a final, a story, a take). Asks only to add, never to read.
enum SaveToPhotos {
    static let videos: Set<String> = ["mp4", "mov", "m4v"]
    static let photos: Set<String> = ["jpg", "jpeg", "png", "heic", "heif", "gif"]

    /// Told the Photos ids of what was just added, so the uploader can mark them as already in the library and never
    /// offer a finished piece back as footage.
    @MainActor static var added: (([String]) -> Void)?

    static func isMedia(_ file: URL) -> Bool {
        let ext = file.pathExtension.lowercased()
        return videos.contains(ext) || photos.contains(ext)
    }

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    @MainActor
    static func add(_ files: [URL]) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw Failure(message: "Allow Creator Toolset to add to Photos in Settings.")
        }
        var ids: [String] = []
        try await PHPhotoLibrary.shared().performChanges {
            for file in files where isMedia(file) {
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = file.lastPathComponent
                request.addResource(with: videos.contains(file.pathExtension.lowercased()) ? .video : .photo,
                                    fileURL: file, options: options)
                if let id = request.placeholderForCreatedAsset?.localIdentifier { ids.append(id) }
            }
        }
        added?(ids)
    }
}
