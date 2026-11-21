import AppKit

private final class FirstMouseButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class ControlPanel {
    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    private final class Control: NSObject {
        let stop: () -> Void
        let resume: () -> Void

        init(stop: @escaping () -> Void, resume: @escaping () -> Void) {
            self.stop = stop
            self.resume = resume
        }

        @objc func clicked() { stop() }

        @objc func resumed() { resume() }
    }

    private let panel: Panel
    private let control: Control
    private let title: NSTextField
    private let detail: NSTextField
    private let resumeButton: FirstMouseButton
    private let scope: String
    private var visibilityObserver: NSObjectProtocol?
    private var visibilityTimeout: Timer?
    private var visibilityWaiter: CheckedContinuation<Bool, Never>?

    init?(app: String, scope: String, stop: @escaping () -> Void, resume: @escaping () -> Void = {}) {
        guard let screen = NSScreen.screens.first else { return nil }
        let visible = screen.visibleFrame.insetBy(dx: 16, dy: 16)
        guard visible.width >= 308, visible.height >= 52 else { return nil }
        let frame = NSRect(x: visible.maxX - 308, y: visible.maxY - 52, width: 308, height: 52)
        control = Control(stop: stop, resume: resume)
        self.scope = scope
        title = NSTextField(labelWithString: "YCoding · Controlling \(app)")
        detail = NSTextField(labelWithString: scope)
        resumeButton = FirstMouseButton(title: "Resume", target: control, action: #selector(Control.resumed))
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
        title.frame = NSRect(x: 12, y: 27, width: 207, height: 16)
        title.font = NSFont(name: "Geist", size: 12) ?? .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = NSColor(srgbRed: 242 / 255, green: 243 / 255, blue: 245 / 255, alpha: 1)
        title.lineBreakMode = .byTruncatingTail
        detail.frame = NSRect(x: 12, y: 9, width: 207, height: 15)
        detail.font = NSFont(name: "Geist", size: 11) ?? .systemFont(ofSize: 11)
        detail.textColor = NSColor(srgbRed: 103 / 255, green: 215 / 255, blue: 164 / 255, alpha: 1)
        detail.lineBreakMode = .byTruncatingTail
        let button = FirstMouseButton(title: "Stop", target: control, action: #selector(Control.clicked))
        button.frame = NSRect(x: 225, y: 11, width: 71, height: 30)
        button.bezelStyle = .rounded
        button.bezelColor = .systemRed
        button.font = NSFont(name: "Geist", size: 12) ?? .systemFont(ofSize: 12, weight: .semibold)
        button.setAccessibilityLabel("Stop \(app) control")
        resumeButton.frame = NSRect(x: 148, y: 11, width: 71, height: 30)
        resumeButton.bezelStyle = .rounded
        resumeButton.font = NSFont(name: "Geist", size: 12) ?? .systemFont(ofSize: 12, weight: .semibold)
        resumeButton.setAccessibilityLabel("Resume \(app) control")
        resumeButton.isHidden = true
        content.addSubview(title)
        content.addSubview(detail)
        content.addSubview(resumeButton)
        content.addSubview(button)
        panel.contentView = content
    }

    var visible: Bool { panel.isVisible && panel.occlusionState.contains(.visible) }

    func pause(_ reason: PauseReason) {
        let text = switch reason {
        case .foregroundRequired: "Paused · Finish this step yourself"
        case .dialog: "Paused · A dialog needs you"
        case .captcha: "Paused · Solve the CAPTCHA yourself"
        case .sensitive: "Paused · Sensitive input needs you"
        }
        detail.stringValue = text
        detail.textColor = NSColor(srgbRed: 240 / 255, green: 190 / 255, blue: 98 / 255, alpha: 1)
        title.frame.size.width = 130
        detail.frame.size.width = 130
        resumeButton.isHidden = false
    }

    func resume() {
        detail.stringValue = scope
        detail.textColor = NSColor(srgbRed: 103 / 255, green: 215 / 255, blue: 164 / 255, alpha: 1)
        title.frame.size.width = 207
        detail.frame.size.width = 207
        resumeButton.isHidden = true
    }

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
final class ChromeProfilePanel: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let request: ChromeProfileRequest
    private var waiter: CheckedContinuation<Bool, Never>?
    private var expiry: Timer?

    init?(_ request: ChromeProfileRequest) {
        guard let screen = NSScreen.screens.first else { return nil }
        let area = screen.visibleFrame.insetBy(dx: 16, dy: 16)
        guard area.width >= 460, area.height >= 196 else { return nil }
        self.request = request
        let frame = NSRect(x: area.maxX - 460, y: area.maxY - 184, width: 460, height: 172)
        panel = NSPanel(contentRect: frame, styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = "YCoding Chrome Profile"
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.delegate = self

        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(srgbRed: 36 / 255, green: 40 / 255, blue: 47 / 255, alpha: 1).cgColor
        let frost = NSColor(srgbRed: 242 / 255, green: 243 / 255, blue: 245 / 255, alpha: 1)
        let prompt = NSTextField(labelWithString: "Allow this Chrome profile to connect to YCoding?")
        prompt.frame = NSRect(x: 16, y: 136, width: 428, height: 18)
        prompt.font = NSFont(name: "Geist", size: 13) ?? .systemFont(ofSize: 13, weight: .semibold)
        prompt.textColor = frost
        let profile = NSTextField(labelWithString: "Profile: \(request.profileLabel)")
        profile.frame = NSRect(x: 16, y: 112, width: 428, height: 16)
        profile.font = NSFont(name: "Geist", size: 12) ?? .systemFont(ofSize: 12)
        profile.textColor = frost
        profile.lineBreakMode = .byTruncatingMiddle
        let code = NSTextField(labelWithString: "Match code: \(request.matchCode)")
        code.frame = NSRect(x: 16, y: 84, width: 428, height: 20)
        code.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .medium)
        code.textColor = NSColor(srgbRed: 103 / 255, green: 215 / 255, blue: 164 / 255, alpha: 1)
        let hint = NSTextField(labelWithString: "Allow only if the extension popup shows the same code.")
        hint.frame = NSRect(x: 16, y: 60, width: 428, height: 16)
        hint.font = NSFont(name: "Geist", size: 11) ?? .systemFont(ofSize: 11)
        hint.textColor = frost
        let deny = FirstMouseButton(title: "Deny", target: self, action: #selector(denied))
        deny.frame = NSRect(x: 256, y: 13, width: 90, height: 30)
        deny.keyEquivalent = "\u{1B}"
        deny.bezelStyle = .rounded
        let allow = FirstMouseButton(title: "Allow", target: self, action: #selector(allowed))
        allow.frame = NSRect(x: 354, y: 13, width: 90, height: 30)
        allow.bezelStyle = .rounded
        allow.bezelColor = NSColor(srgbRed: 103 / 255, green: 215 / 255, blue: 164 / 255, alpha: 1)
        allow.setAccessibilityLabel("Allow Chrome profile \(request.profileLabel)")
        for view in [prompt, profile, code, hint, deny, allow] as [NSView] { content.addSubview(view) }
        panel.contentView = content
    }

    func decide() async -> Bool {
        let remaining = TimeInterval(request.expiresAt) / 1000 - Date.now.timeIntervalSince1970
        guard remaining > 0, waiter == nil else { return false }
        return await withCheckedContinuation { continuation in
            waiter = continuation
            let timer = Timer(timeInterval: remaining, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.finish(false) }
            }
            expiry = timer
            RunLoop.main.add(timer, forMode: .common)
            panel.orderFrontRegardless()
        }
    }

    func windowWillClose(_ notification: Notification) { finish(false) }

    @objc private func denied() { finish(false) }

    @objc private func allowed() {
        guard let id = UInt32(exactly: panel.windowNumber), panel.isVisible,
              WindowHost.elevatedWindowVisible(id, owner: getpid()),
              request.valid(now: Int64(Date.now.timeIntervalSince1970 * 1000)) else { return finish(false) }
        finish(true)
    }

    private func finish(_ approved: Bool) {
        expiry?.invalidate()
        expiry = nil
        panel.orderOut(nil)
        let continuation = waiter
        waiter = nil
        continuation?.resume(returning: approved)
    }
}
