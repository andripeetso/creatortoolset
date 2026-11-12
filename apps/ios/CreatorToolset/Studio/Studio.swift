import Foundation

/// The studio plug-in. The screens in this folder show only on a server that lists it (`ServerPlugins.studio`), and
/// only there do they call its routes.
enum Studio {
    static let plugin = "baby-acrobatics"

    /// One of its routes: `Studio.path("/push/register")`.
    static func path(_ rest: String) -> String { "/api/x/\(plugin)\(rest)" }
}

extension ServerPlugins {
    /// The server in use has the studio plug-in.
    var studio: Bool { has(Studio.plugin) }
}
