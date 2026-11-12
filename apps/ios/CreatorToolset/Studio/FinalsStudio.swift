import Foundation

/// The studio's Finals: its list (`GET /api/library?trash=0`) holds the catalog's stacks and the Media Library's Finals
/// in one answer, with whole-number ids. Asked only when the server lists the plug-in and the account has
/// `finals-catalog` on (`FinalsModel.usesStudio`).
extension API {
    func studioFinals() async throws -> FinalsData {
        var data: FinalsData = try await get("/api/library?trash=0", decoder: API.snake)
        data.stacks = data.stacks.map { piece in
            var piece = piece
            // the picked frame, stamped with when the piece last changed so a new pick is fetched again
            if piece.hasCover?.value == true {
                let v = (piece.updatedAt ?? "").addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
                piece.coverUrl = "/api/library/stacks/\(piece.id)/cover?v=\(v)"
            }
            return piece
        }
        return data
    }
}
