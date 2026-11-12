import Foundation

/// Where the studio plug-in's parts join the app. The app calls each at its moment; each part checks for the plug-in
/// itself (`ServerPlugins.studio`).
enum StudioHooks {
    /// At launch, a background relaunch included.
    @MainActor static func launched() {
        EditorChats.register()
        Push.start()
    }

    /// Another server is in use (or the first one was added).
    @MainActor static func serverChanged() { Push.serverChanged() }

    /// iOS handed over the phone's push token.
    static func pushToken(_ token: Data) async { await Push.took(token) }

    /// A server is being removed from the phone; its sign-in still works for this call.
    static func removing(_ api: API) async { await Push.forget(on: api) }
}
