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

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        append(event.characters ?? "", to: URL(fileURLWithPath: state.path + ".keys"))
    }

    override func scrollWheel(with event: NSEvent) {
        append("s", to: URL(fileURLWithPath: state.path + ".scrolls"))
    }

    func append(_ text: String, to url: URL) {
        let existing = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (existing + text).write(to: url, atomically: true, encoding: .utf8)
        needsDisplay = true
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
        if let view = window.contentView { window.makeFirstResponder(view) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
            guard let id = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == getpid() &&
                ($0[kCGWindowLayer as String] as? Int) == 0 })?[kCGWindowNumber as String] as? UInt32 else { return }
            let ready = URL(fileURLWithPath: CommandLine.arguments[1] + ".ready")
            try? "\(getpid())/\(id)".write(to: ready, atomically: true, encoding: .utf8)
        }
    }
}

func observe(log path: String) -> Never {
    let log = URL(fileURLWithPath: path)
    let stop = path + ".stop"
    FileManager.default.createFile(atPath: path, contents: nil)
    func record(_ line: String) {
        guard let handle = try? FileHandle(forWritingTo: log) else { return }
        handle.seekToEndOfFile()
        handle.write(Data((line + "\n").utf8))
        try? handle.close()
    }
    func position() -> String? {
        guard let point = CGEvent(source: nil)?.location else { return nil }
        return "\(point.x),\(point.y)"
    }
    func inventory() -> String {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.compactMap { window -> String? in
            guard (window[kCGWindowLayer as String] as? Int) == 0,
                  let owner = window[kCGWindowOwnerPID as String] as? Int32,
                  let id = window[kCGWindowNumber as String] as? UInt32 else { return nil }
            return "\(owner)/\(id)"
        }.joined(separator: " ")
    }
    guard var cursor = position() else {
        record("cursor-unavailable")
        exit(2)
    }
    var front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    var order = inventory()
    var seen = Set<String>()
    var ticks = 0
    let token = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: nil) { _ in record("space-changed") }
    record("frontmost \(front)")
    record("cursor \(cursor)")
    record("windows \(order)")
    record("ready")
    while !FileManager.default.fileExists(atPath: stop) {
        ticks += 1
        let current = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        if current != front {
            front = current
            record("frontmost-changed \(current)")
        }
        if let now = position() {
            if now != cursor {
                cursor = now
                record("cursor-moved \(now)")
            }
        } else {
            record("cursor-unavailable")
        }
        let currentOrder = inventory()
        if currentOrder != order {
            order = currentOrder
            record("windows-changed \(currentOrder)")
        }
        let helpers = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "app.ycoding.computer-use").map(\.processIdentifier))
        let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
        for window in windows {
            let owner = window[kCGWindowOwnerPID as String] as? Int32 ?? 0
            let ownerName = window[kCGWindowOwnerName as String] as? String ?? ""
            guard helpers.contains(owner) || ownerName.hasPrefix("YCoding Computer Use") else { continue }
            let id = window[kCGWindowNumber as String] as? UInt32 ?? 0
            let layer = window[kCGWindowLayer as String] as? Int ?? 0
            if seen.insert("\(owner)/\(id)").inserted { record("helper-window \(owner)/\(id) layer \(layer)") }
        }
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
    NSWorkspace.shared.notificationCenter.removeObserver(token)
    record("ticks \(ticks)")
    exit(0)
}

if CommandLine.arguments[2] == "observe" { observe(log: CommandLine.arguments[1]) }

try? String(getpid()).write(toFile: CommandLine.arguments[1] + ".pid", atomically: true, encoding: .utf8)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate(state: URL(fileURLWithPath: CommandLine.arguments[1]), activate: CommandLine.arguments[2] == "activate")
app.delegate = delegate
app.run()
