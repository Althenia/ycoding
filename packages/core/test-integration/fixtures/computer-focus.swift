import AppKit
import Foundation
import CoreGraphics

final class FixtureView: NSView {
    let state: URL
    let activate: Bool
    var clicks = 0

    init(state: URL, activate: Bool) {
        self.state = state
        self.activate = activate
        super.init(frame: NSRect(x: 0, y: 0, width: 320, height: 220))
    }

    required init?(coder: NSCoder) { fatalError("Unavailable") }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        NSColor.black.set()
        NSString(string: "Clicks: \(clicks)").draw(at: NSPoint(x: 35, y: 120), withAttributes: [.font: NSFont.systemFont(ofSize: 24)])
    }

    override func mouseDown(with event: NSEvent) {
        clicks += 1
        try? String(clicks).write(to: state, atomically: true, encoding: .utf8)
        needsDisplay = true
        if activate { NSApp.activate(ignoringOtherApps: true) }
    }

}

final class Delegate: NSObject, NSApplicationDelegate {
    let window: NSWindow
    init(state: URL, activate: Bool) {
        window = NSWindow(contentRect: NSRect(x: 220, y: 220, width: 320, height: 220),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "YCoding Focus Fixture"
        window.contentView = FixtureView(state: state, activate: activate)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window.orderFrontRegardless()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
            guard let id = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == getpid() &&
                ($0[kCGWindowLayer as String] as? Int) == 0 })?[kCGWindowNumber as String] as? UInt32 else { return }
            let ready = URL(fileURLWithPath: CommandLine.arguments[1] + ".ready")
            try? "\(getpid())/\(id)".write(to: ready, atomically: true, encoding: .utf8)
        }
    }
}

try? String(getpid()).write(toFile: CommandLine.arguments[1] + ".pid", atomically: true, encoding: .utf8)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate(state: URL(fileURLWithPath: CommandLine.arguments[1]), activate: CommandLine.arguments[2] == "activate")
app.delegate = delegate
app.run()
