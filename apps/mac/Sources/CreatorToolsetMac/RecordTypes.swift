import AppKit

/// What a recording captures: a whole display, one window, or an area of a display.
enum RecordSource: Equatable {
    case display(CGDirectDisplayID)
    /// The window's frame when it was picked: global points, top-left origin.
    case window(CGWindowID, CGRect)
    /// `rect` in the display's points, top-left origin.
    case area(CGDirectDisplayID, CGRect)
}

/// The toolbar's three source buttons.
enum SourceKind: String, CaseIterable { case display, window, area }

/// Where a finished recording is sent from the preview or the /record page.
enum ShareDestination: String { case review, notes, guide }
