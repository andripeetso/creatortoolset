import AppKit

/// What a recording captures: a whole display, one window, or an area of a display.
enum RecordSource: Equatable {
    case display(CGDirectDisplayID)
    case window(CGWindowID)
    /// `rect` in the display's points, top-left origin.
    case area(CGDirectDisplayID, CGRect)
}

/// The toolbar's three source buttons.
enum SourceKind: String, CaseIterable { case display, window, area }

/// Where a finished recording is sent from the preview or the /record page.
enum ShareDestination: String { case review, notes, guide }
