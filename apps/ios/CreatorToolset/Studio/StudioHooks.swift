import Foundation

/// Where the studio plug-in's parts join the app. The app already calls each at its moment; each does nothing until
/// that part is built (this whole file is then replaced).
enum StudioHooks {
    /// At launch, a background relaunch included.
    @MainActor static func launched() {}
    /// Another server is in use (or the first one was added).
    @MainActor static func serverChanged() {}
    /// iOS handed over the phone's push token.
    static func pushToken(_ token: Data) async {}
    /// A server is being removed from the phone; its sign-in still works for this call.
    static func removing(_ api: API) async {}
}
