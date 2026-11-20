import AppKit

@MainActor
final class ControlPanel {
    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    private final class StopButton: NSButton {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    }

    private final class Control: NSObject {
        let stop: () -> Void

        init(_ stop: @escaping () -> Void) { self.stop = stop }

        @objc func clicked() { stop() }
    }

    private let panel: Panel
    private let control: Control
    private var visibilityObserver: NSObjectProtocol?
    private var visibilityTimeout: Timer?
    private var visibilityWaiter: CheckedContinuation<Bool, Never>?

    init?(app: String, scope: String, stop: @escaping () -> Void) {
        guard let screen = NSScreen.screens.first else { return nil }
        let visible = screen.visibleFrame.insetBy(dx: 16, dy: 16)
        guard visible.width >= 308, visible.height >= 52 else { return nil }
        let frame = NSRect(x: visible.maxX - 308, y: visible.maxY - 52, width: 308, height: 52)
        control = Control(stop)
        panel = Panel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.setAccessibilityLabel("YCoding computer control")

        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(srgbRed: 36 / 255, green: 40 / 255, blue: 47 / 255, alpha: 1).cgColor
        content.layer?.borderColor = NSColor(srgbRed: 58 / 255, green: 64 / 255, blue: 74 / 255, alpha: 1).cgColor
        content.layer?.borderWidth = 1
        content.layer?.cornerRadius = 8
        let title = NSTextField(labelWithString: "YCoding · Controlling \(app)")
        title.frame = NSRect(x: 12, y: 27, width: 207, height: 16)
        title.font = NSFont(name: "Geist", size: 12) ?? .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = NSColor(srgbRed: 242 / 255, green: 243 / 255, blue: 245 / 255, alpha: 1)
        title.lineBreakMode = .byTruncatingTail
        let detail = NSTextField(labelWithString: scope)
        detail.frame = NSRect(x: 12, y: 9, width: 207, height: 15)
        detail.font = NSFont(name: "Geist", size: 11) ?? .systemFont(ofSize: 11)
        detail.textColor = NSColor(srgbRed: 103 / 255, green: 215 / 255, blue: 164 / 255, alpha: 1)
        let button = StopButton(title: "Stop", target: control, action: #selector(Control.clicked))
        button.frame = NSRect(x: 225, y: 11, width: 71, height: 30)
        button.bezelStyle = .rounded
        button.bezelColor = .systemRed
        button.font = NSFont(name: "Geist", size: 12) ?? .systemFont(ofSize: 12, weight: .semibold)
        button.setAccessibilityLabel("Stop \(app) control")
        content.addSubview(title)
        content.addSubview(detail)
        content.addSubview(button)
        panel.contentView = content
    }

    var visible: Bool { panel.isVisible && panel.occlusionState.contains(.visible) }

    func show() async -> Bool {
        panel.orderFrontRegardless()
        if visible { return true }
        return await withCheckedContinuation { continuation in
            visibilityWaiter = continuation
            visibilityObserver = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification,
                object: panel, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    if self?.visible == true { self?.settleVisibility(true) }
                }
            }
            let timer = Timer(timeInterval: 1, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.settleVisibility(self?.visible == true) }
            }
            visibilityTimeout = timer
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    private func settleVisibility(_ value: Bool) {
        if let visibilityObserver { NotificationCenter.default.removeObserver(visibilityObserver) }
        visibilityObserver = nil
        visibilityTimeout?.invalidate()
        visibilityTimeout = nil
        let waiter = visibilityWaiter
        visibilityWaiter = nil
        waiter?.resume(returning: value)
    }

    func hide() {
        settleVisibility(false)
        panel.orderOut(nil)
    }
}

@MainActor
final class WindowChooser: NSObject, NSWindowDelegate {
    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { true }
    }

    private let panel: Panel
    private let popup: NSPopUpButton
    private let options: [(UUID, String)]
    private var waiter: CheckedContinuation<UUID?, Never>?
    private var expiry: Timer?

    init?(options: [(UUID, String)]) {
        guard !options.isEmpty, let screen = NSScreen.screens.first else { return nil }
        let area = screen.visibleFrame.insetBy(dx: 16, dy: 16)
        guard area.width >= 460, area.height >= 160 else { return nil }
        self.options = options
        let frame = NSRect(x: area.maxX - 460, y: area.maxY - 145, width: 460, height: 136)
        panel = Panel(contentRect: frame, styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
        popup = NSPopUpButton(frame: NSRect(x: 16, y: 54, width: 428, height: 30), pullsDown: false)
        super.init()

        panel.title = "YCoding Window Control"
        panel.level = .floating
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.delegate = self
        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(srgbRed: 36 / 255, green: 40 / 255, blue: 47 / 255, alpha: 1).cgColor
        let prompt = NSTextField(labelWithString: "Choose one window for this Session.")
        prompt.frame = NSRect(x: 16, y: 99, width: 428, height: 19)
        prompt.font = NSFont(name: "Geist", size: 13) ?? .systemFont(ofSize: 13, weight: .semibold)
        prompt.textColor = NSColor(srgbRed: 242 / 255, green: 243 / 255, blue: 245 / 255, alpha: 1)
        popup.setAccessibilityLabel("Window to control")
        popup.addItems(withTitles: options.map { $0.1 })
        popup.font = NSFont(name: "Geist", size: 12) ?? .systemFont(ofSize: 12)
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelled))
        cancel.frame = NSRect(x: 256, y: 13, width: 90, height: 30)
        cancel.keyEquivalent = "\u{1B}"
        cancel.bezelStyle = .rounded
        let select = NSButton(title: "Continue", target: self, action: #selector(selected))
        select.frame = NSRect(x: 354, y: 13, width: 90, height: 30)
        select.keyEquivalent = "\r"
        select.bezelStyle = .rounded
        select.bezelColor = NSColor(srgbRed: 103 / 255, green: 215 / 255, blue: 164 / 255, alpha: 1)
        for view in [prompt, popup, cancel, select] as [NSView] { content.addSubview(view) }
        panel.contentView = content
        panel.initialFirstResponder = popup
    }

    func select(until expiresAt: Int64) async -> UUID? {
        let remaining = TimeInterval(expiresAt) / 1000 - Date.now.timeIntervalSince1970
        guard remaining > 0 else { return nil }
        return await withCheckedContinuation { continuation in
            waiter = continuation
            let timer = Timer(timeInterval: remaining, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.finish(nil) }
            }
            expiry = timer
            RunLoop.main.add(timer, forMode: .common)
            panel.orderFrontRegardless()
        }
    }

    func windowWillClose(_ notification: Notification) { finish(nil) }

    @objc private func cancelled() { finish(nil) }

    @objc private func selected() {
        let index = popup.indexOfSelectedItem
        finish(panel.isVisible && options.indices.contains(index) ? options[index].0 : nil)
    }

    private func finish(_ id: UUID?) {
        expiry?.invalidate()
        expiry = nil
        panel.orderOut(nil)
        let continuation = waiter
        waiter = nil
        continuation?.resume(returning: id)
    }
}

@MainActor
final class ChromeEnrollmentMenu: NSObject {
    private let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let select: () -> Void

    init?(select: @escaping () -> Void) {
        self.select = select
        super.init()
        guard let button = status.button else { NSStatusBar.system.removeStatusItem(status); return nil }
        button.title = "YCoding"
        let menu = NSMenu()
        let connect = NSMenuItem(title: "Connect Chrome", action: #selector(connectChrome), keyEquivalent: "")
        connect.target = self
        menu.addItem(connect)
        status.menu = menu
    }

    @objc private func connectChrome() { select() }
}

@MainActor
final class ChromeEnrollmentPanel: NSObject, NSWindowDelegate {
    private final class CloseButton: NSButton {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    }

    private let panel: NSPanel
    private let code = NSTextField(labelWithString: "")
    private let request: ChromeEnrollmentRequest
    private let dismissed: () -> Void
    private var hidden = false
    private var timer: Timer?

    init?(_ request: ChromeEnrollmentRequest, dismissed: @escaping () -> Void) {
        guard let screen = NSScreen.screens.first else { return nil }
        let area = screen.visibleFrame.insetBy(dx: 16, dy: 16)
        guard area.width >= 460, area.height >= 172 else { return nil }
        self.request = request
        self.dismissed = dismissed
        let frame = NSRect(x: area.maxX - 460, y: area.maxY - 160, width: 460, height: 148)
        panel = NSPanel(contentRect: frame, styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = "YCoding Chrome Enrollment"
        panel.level = .statusBar
        panel.sharingType = .none
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.delegate = self

        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(srgbRed: 36 / 255, green: 40 / 255, blue: 47 / 255, alpha: 1).cgColor
        let instructions = NSTextField(labelWithString: "Enter this one-time code in the YCoding Chrome extension.")
        instructions.frame = NSRect(x: 16, y: 111, width: 428, height: 18)
        instructions.font = NSFont(name: "Geist", size: 13) ?? .systemFont(ofSize: 13, weight: .semibold)
        instructions.textColor = .white
        let origin = NSTextField(labelWithString: request.origin)
        origin.frame = NSRect(x: 16, y: 86, width: 428, height: 16)
        origin.font = NSFont(name: "Geist", size: 12) ?? .systemFont(ofSize: 12)
        origin.textColor = .white
        code.frame = NSRect(x: 16, y: 52, width: 428, height: 20)
        code.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .medium)
        code.textColor = NSColor(srgbRed: 103 / 255, green: 215 / 255, blue: 164 / 255, alpha: 1)
        code.isSelectable = false
        let done = CloseButton(title: "Close", target: self, action: #selector(dismiss))
        done.frame = NSRect(x: 354, y: 12, width: 90, height: 30)
        done.bezelStyle = .rounded
        done.keyEquivalent = "\u{1B}"
        for view in [instructions, origin, code, done] as [NSView] { content.addSubview(view) }
        panel.contentView = content
    }

    func show() async -> Bool {
        guard !hidden else { return false }
        panel.orderFrontRegardless()
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        guard let id = UInt32(exactly: panel.windowNumber), allowed(id) else {
            panel.orderOut(nil)
            return false
        }
        code.stringValue = request.code
        monitor(id)
        return true
    }

    private func allowed(_ id: CGWindowID) -> Bool {
        guard !hidden, panel.isVisible, panel.sharingType == .none, panel.windowNumber == Int(id),
              WindowHost.enrollmentWindowVisible(id, owner: getpid()) else { return false }
        return request.valid(now: Int64(Date.now.timeIntervalSince1970 * 1000))
    }

    private func monitor(_ id: CGWindowID) {
        let remaining = TimeInterval(request.expiresAt) / 1000 - Date.now.timeIntervalSince1970
        guard remaining > 0 else { dismiss(); return }
        let timer = Timer(timeInterval: min(0.2, remaining), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.allowed(id) { self.monitor(id); return }
                self.dismiss()
            }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func windowWillClose(_ notification: Notification) { dismiss() }

    @objc private func dismiss() {
        hide()
        dismissed()
    }

    func hide() {
        hidden = true
        code.stringValue = ""
        timer?.invalidate()
        timer = nil
        panel.orderOut(nil)
    }
}
