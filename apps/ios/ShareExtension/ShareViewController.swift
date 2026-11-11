import UIKit

/// Share → Creator Toolset. Not offered yet: the activation rule in Info.plist matches nothing until this screen is
/// built, so the share sheet never shows an entry that does nothing.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        extensionContext?.completeRequest(returningItems: nil)
    }
}
