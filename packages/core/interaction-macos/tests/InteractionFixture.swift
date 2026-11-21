import AppKit

private final class FocusOnlyField: NSTextField {
    weak var counter: NSTextField?
    private var attempts = 0

    override func setAccessibilityValue(_ value: Any?) {
        attempts += 1
        counter?.stringValue = "Filter value attempts: \(attempts)"
        guard window?.isKeyWindow == true else { return }
        super.setAccessibilityValue(value)
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
private final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 420),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    private let search = NSTextField(string: "")
    private let filter = FocusOnlyField(string: "")
    private let filterAttempts = NSTextField(labelWithString: "Filter value attempts: 0")
    private let increment = NSButton(title: "Increment count: 0", target: nil, action: nil)
    private let dialogButton = NSButton(title: "Show dialog", target: nil, action: nil)
    private let signIn = NSButton(title: "Show sign-in field", target: nil, action: nil)
    private let secure = NSSecureTextField(string: "")
    private let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 432, height: 72))
    private let dialog = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 220, height: 96), styleMask: [.titled], backing: .buffered, defer: false)
    private let cover = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 140, height: 48), styleMask: [.titled], backing: .buffered, defer: false)
    private var count = 0
    private let preview: Bool
    private var ready = false

    init(preview: Bool) { self.preview = preview }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Synthetic Interaction Fixture"
        let caption = NSTextField(labelWithString: "Search")
        search.placeholderString = "Search"
        search.setAccessibilityLabel("Search")
        search.setAccessibilityTitleUIElement(caption)
        filter.placeholderString = "Filter"
        filter.setAccessibilityLabel("Filter")
        filter.counter = filterAttempts
        increment.target = self
        increment.action = #selector(advance)
        increment.bezelStyle = .rounded
        dialogButton.target = self
        dialogButton.action = #selector(showDialog)
        dialogButton.bezelStyle = .rounded
        signIn.target = self
        signIn.action = #selector(toggleSignIn)
        signIn.bezelStyle = .rounded
        secure.isHidden = true
        scroll.hasVerticalScroller = true
        scroll.scrollerStyle = .legacy
        scroll.documentView = FlippedView(frame: NSRect(x: 0, y: 0, width: 400, height: 1200))
        let stack = NSStackView(views: [caption, search, filter, filterAttempts, increment, dialogButton, signIn, secure, scroll])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        guard let root = window.contentView else { return }
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 24),
            search.widthAnchor.constraint(equalTo: stack.widthAnchor),
            filter.widthAnchor.constraint(equalTo: stack.widthAnchor),
            secure.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 72),
        ])
        guard preview else {
            window.center()
            window.makeKeyAndOrderFront(nil)
            return
        }
        report(NSApplication.didBecomeActiveNotification, object: NSApp, as: "app-active")
        report(NSWindow.didBecomeKeyNotification, object: window, as: "window-key")
        report(NSWindow.didBecomeMainNotification, object: window, as: "window-main")
        if let screen = NSScreen.screens.first?.visibleFrame {
            window.setFrameOrigin(NSPoint(x: screen.maxX - window.frame.width - 24, y: screen.maxY - window.frame.height - 96))
        }
        window.delegate = self
        window.collectionBehavior = [.ignoresCycle]
        window.orderBack(nil)
        cover.title = "Fixture cover"
        cover.collectionBehavior = window.collectionBehavior
        cover.setFrameOrigin(NSPoint(x: window.frame.maxX - cover.frame.width - 8, y: window.frame.minY + 8))
        DispatchQueue.main.async { self.announce() }
    }

    private func report(_ name: Notification.Name, object: Any?, as event: String) {
        NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { _ in
            FileHandle.standardOutput.write(Data("event \(event)\n".utf8))
        }
    }

    private func announce() {
        guard !ready, window.isVisible else { return }
        ready = true
        cover.order(.above, relativeTo: window.windowNumber)
        FileHandle.standardOutput.write(Data("\(getpid())/\(window.windowNumber)\ncover \(cover.windowNumber)\n".utf8))
    }

    @objc private func advance() {
        count += 1
        increment.title = "Increment count: \(count)"
    }

    @objc private func showDialog() {
        dialog.title = "Synthetic dialog"
        dialog.isReleasedWhenClosed = false
        dialog.setAccessibilityModal(true)
        let dismiss = NSButton(title: "Dismiss", target: self, action: #selector(dismissDialog))
        dismiss.frame = NSRect(x: 60, y: 24, width: 100, height: 32)
        dialog.contentView?.subviews.forEach { $0.removeFromSuperview() }
        dialog.contentView?.addSubview(dismiss)
        dialog.collectionBehavior = window.collectionBehavior
        dialog.setFrameOrigin(NSPoint(x: window.frame.midX - dialog.frame.width / 2, y: window.frame.midY))
        dialog.order(.above, relativeTo: window.windowNumber)
    }

    @objc private func dismissDialog() { dialog.orderOut(nil) }

    @objc private func toggleSignIn() { secure.isHidden.toggle() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct InteractionFixture {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let preview = CommandLine.arguments.contains("--preview-test")
        let fixture = Fixture(preview: preview)
        app.delegate = fixture
        let policy: NSApplication.ActivationPolicy = preview ? .accessory : .regular
        _ = app.setActivationPolicy(policy)
        guard app.activationPolicy() == policy else { _exit(2) }
        withExtendedLifetime(fixture) { app.run() }
    }
}
