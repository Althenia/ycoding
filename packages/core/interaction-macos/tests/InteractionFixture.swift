import AppKit

@MainActor
private final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 220),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    private let search = NSTextField(string: "")
    private let increment = NSButton(title: "Increment count: 0", target: nil, action: nil)
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
        increment.target = self
        increment.action = #selector(advance)
        increment.bezelStyle = .rounded
        let stack = NSStackView(views: [caption, search, increment])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        guard let root = window.contentView else { return }
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 24),
            search.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        window.center()
        guard preview else { window.makeKeyAndOrderFront(nil); return }
        window.delegate = self
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        window.orderFrontRegardless()
    }

    func windowDidChangeOcclusionState(_ notification: Notification) {
        guard !ready, window.isVisible, window.occlusionState.contains(.visible) else { return }
        ready = true
        FileHandle.standardOutput.write(Data("\(window.windowNumber)\n".utf8))
    }

    @objc private func advance() {
        count += 1
        increment.title = "Increment count: \(count)"
    }

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
        guard app.setActivationPolicy(preview ? .accessory : .regular) else { _exit(2) }
        withExtendedLifetime(fixture) { app.run() }
    }
}
