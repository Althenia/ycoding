import AppKit
import ApplicationServices
import XCTest

final class FenceTests: XCTestCase {
    private let window = InteractionTarget(pid: 4100, started: "100:21", bundleID: "local.synthetic.Example", windowID: 72)

    func testConsentMustBeBoundAndVisible() throws {
        let fence = InteractionFence()
        let pending = try fence.begin(window)
        XCTAssertThrowsError(try fence.check(pending, target: window)) { XCTAssertEqual($0 as? Refusal, .notAuthorized) }
        let other = InteractionTarget(pid: 4100, started: "100:21", bundleID: "local.synthetic.Example", windowID: 73)
        XCTAssertThrowsError(try fence.activate(pending, target: other, visible: true)) { XCTAssertEqual($0 as? Refusal, .targetChanged) }
        XCTAssertThrowsError(try fence.activate(pending, target: window, visible: false)) { XCTAssertEqual($0 as? Refusal, .notAuthorized) }
        try fence.activate(pending, target: window, visible: true)
        XCTAssertNoThrow(try fence.check(pending, target: window))
    }

    func testDispatchRequiresFreshObservationAndExactProcess() throws {
        let fence = InteractionFence()
        let lease = try fence.begin(window)
        try fence.activate(lease, target: window, visible: true)
        try fence.observed(lease, target: window, revision: "fresh")
        let recycled = InteractionTarget(pid: 4100, started: "101:08", bundleID: "local.synthetic.Example", windowID: 72)
        XCTAssertThrowsError(try fence.dispatch(lease, target: recycled, revision: "fresh")) { XCTAssertEqual($0 as? Refusal, .targetChanged) }
        XCTAssertThrowsError(try fence.dispatch(lease, target: window, revision: "old")) { XCTAssertEqual($0 as? Refusal, .staleRevision) }
        try fence.dispatch(lease, target: window, revision: "fresh")
        XCTAssertThrowsError(try fence.dispatch(lease, target: window, revision: "fresh")) { XCTAssertEqual($0 as? Refusal, .staleRevision) }
    }

    func testStopRejectsQueuedDispatchAndLateCapture() throws {
        let fence = InteractionFence()
        let lease = try fence.begin(window)
        try fence.activate(lease, target: window, visible: true)
        try fence.observed(lease, target: window, revision: "fresh")
        XCTAssertTrue(fence.stop(lease))
        XCTAssertThrowsError(try fence.dispatch(lease, target: window, revision: "fresh")) { XCTAssertEqual($0 as? Refusal, .stopped) }
        XCTAssertThrowsError(try fence.check(lease, target: window, revision: "fresh")) { XCTAssertEqual($0 as? Refusal, .stopped) }
        XCTAssertThrowsError(try fence.observed(lease, target: window, revision: "late")) { XCTAssertEqual($0 as? Refusal, .stopped) }
        let another = try fence.begin(window)
        XCTAssertNotEqual(another, lease)
        XCTAssertThrowsError(try fence.check(another, target: window)) { XCTAssertEqual($0 as? Refusal, .notAuthorized) }
    }

    func testPauseRefusesWorkUntilResumedWhileStopStillRevokes() async throws {
        let fence = InteractionFence()
        let lease = try fence.begin(window)
        try fence.activate(lease, target: window, visible: true)
        try fence.observed(lease, target: window, revision: "fresh")
        let early = try await fence.capture(lease, target: window) { _ in "synthetic frame before pause" }
        try fence.pause(lease, target: window, reason: .dialog)
        XCTAssertThrowsError(try early.verify()) { XCTAssertEqual($0 as? Refusal, .paused) }
        XCTAssertThrowsError(try fence.check(lease, target: window)) { XCTAssertEqual($0 as? Refusal, .paused) }
        XCTAssertNoThrow(try fence.check(lease, target: window, whilePaused: true))
        XCTAssertThrowsError(try fence.dispatch(lease, target: window, revision: "fresh")) { XCTAssertEqual($0 as? Refusal, .paused) }
        XCTAssertThrowsError(try fence.observed(lease, target: window, revision: "during pause")) { XCTAssertEqual($0 as? Refusal, .paused) }
        do {
            _ = try await fence.capture(lease, target: window) { _ in
                XCTFail("A paused grant reached capture")
                return "synthetic paused frame"
            }
            XCTFail("A paused grant produced a frame")
        } catch { XCTAssertEqual(error as? Refusal, .paused) }

        try fence.resume(lease, target: window)
        XCTAssertNoThrow(try fence.check(lease, target: window))
        XCTAssertThrowsError(try fence.dispatch(lease, target: window, revision: "fresh")) { XCTAssertEqual($0 as? Refusal, .staleRevision) }
        try fence.observed(lease, target: window, revision: "after resume")
        XCTAssertNoThrow(try fence.dispatch(lease, target: window, revision: "after resume"))

        try fence.pause(lease, target: window, reason: .sensitive)
        XCTAssertTrue(fence.stop(lease))
        XCTAssertThrowsError(try fence.check(lease, target: window, whilePaused: true)) { XCTAssertEqual($0 as? Refusal, .stopped) }
        XCTAssertThrowsError(try fence.resume(lease, target: window)) { XCTAssertEqual($0 as? Refusal, .stopped) }
    }

    func testOnlyForegroundNeedsBecomePauseReasons() {
        XCTAssertEqual(PauseReason(.foregroundRequired), .foregroundRequired)
        XCTAssertEqual(PauseReason(.dialog), .dialog)
        XCTAssertEqual(PauseReason(.captcha), .captcha)
        XCTAssertEqual(PauseReason(.sensitive), .sensitive)
        for refusal in [Refusal.staleRevision, .stopped, .targetChanged, .unsupported, .uncertain, .paused, .permissionMissing] {
            XCTAssertNil(PauseReason(refusal))
        }
        XCTAssertEqual(PauseReason.foregroundRequired.rawValue, "foreground_required")
        XCTAssertTrue(WindowSafety.sensitive(role: "AXSecureTextField", description: ""))
    }

    func testChromeProfileRequestRequiresABoundedLabelCodeAndDeadline() {
        let valid = ChromeProfileRequest(profileLabel: "Work", matchCode: "K7Q2-M9", expiresAt: 1000)
        XCTAssertTrue(valid.valid(now: 999))
        XCTAssertFalse(valid.valid(now: 1000))
        XCTAssertFalse(ChromeProfileRequest(profileLabel: "Work", matchCode: "K7Q2-M9", expiresAt: 200_000).valid(now: 999))
        XCTAssertFalse(ChromeProfileRequest(profileLabel: "", matchCode: "K7Q2", expiresAt: 1000).valid(now: 999))
        XCTAssertFalse(ChromeProfileRequest(profileLabel: " Work", matchCode: "K7Q2", expiresAt: 1000).valid(now: 999))
        XCTAssertFalse(ChromeProfileRequest(profileLabel: "Work\u{202E}", matchCode: "K7Q2", expiresAt: 1000).valid(now: 999))
        XCTAssertFalse(ChromeProfileRequest(profileLabel: "Work", matchCode: "K7Q", expiresAt: 1000).valid(now: 999))
        XCTAssertFalse(ChromeProfileRequest(profileLabel: "Work", matchCode: "K7Q2 M9", expiresAt: 1000).valid(now: 999))
        XCTAssertFalse(ChromeProfileRequest(profileLabel: String(repeating: "W", count: 129), matchCode: "K7Q2", expiresAt: 1000).valid(now: 999))
    }

    @MainActor
    func testControlPanelPauseOffersResumeAndDispatchesIt() throws {
        try runPanelScenario { application, initial in
            var resumes = 0
            var stops = 0
            guard let panel = ControlPanel(app: "Synthetic", scope: "Window 72", stop: { stops += 1 }, resume: { resumes += 1 }) else {
                return XCTFail("Missing control panel")
            }
            defer { panel.hide() }
            let shown = await panel.show()
            XCTAssertTrue(shown)
            guard let window = application.windows.first(where: { !initial.contains(ObjectIdentifier($0)) && $0.isVisible }),
                  let buttons = window.contentView?.subviews.compactMap({ $0 as? NSButton }),
                  let resume = buttons.first(where: { $0.title == "Resume" }),
                  let stop = buttons.first(where: { $0.title == "Stop" }) else { return XCTFail("Missing panel buttons") }
            XCTAssertTrue(resume.isHidden)
            panel.pause(.dialog)
            XCTAssertFalse(resume.isHidden)
            XCTAssertTrue(window.contentView?.subviews.compactMap { $0 as? NSTextField }.contains { $0.stringValue == "Paused · A dialog needs you" } == true)
            resume.performClick(nil)
            XCTAssertEqual(resumes, 1)
            stop.performClick(nil)
            XCTAssertEqual(stops, 1)
            panel.resume()
            XCTAssertTrue(resume.isHidden)
            XCTAssertTrue(window.contentView?.subviews.compactMap { $0 as? NSTextField }.contains { $0.stringValue == "Window 72" } == true)
        }
    }

    @MainActor
    func testChromeProfilePanelAllowsOnlyAnExplicitVisibleChoiceAndDefaultsToDeny() throws {
        try runPanelScenario { application, initial in
            let now = Int64(Date.now.timeIntervalSince1970 * 1000)
            let expiring = try XCTUnwrap(ChromeProfilePanel(ChromeProfileRequest(profileLabel: "Work", matchCode: "K7Q2-M9", expiresAt: now + 300)))
            let expired = await expiring.decide()
            XCTAssertFalse(expired)

            for (choice, expected) in [("Allow", true), ("Deny", false), ("close", false)] {
                let request = ChromeProfileRequest(profileLabel: "Work", matchCode: "K7Q2-M9", expiresAt: Int64(Date.now.timeIntervalSince1970 * 1000) + 10_000)
                let panel = try XCTUnwrap(ChromeProfilePanel(request))
                let decision = Task { @MainActor in await panel.decide() }
                var shown: NSWindow?
                let deadline = ContinuousClock.now.advanced(by: .seconds(2))
                while ContinuousClock.now < deadline {
                    shown = application.windows.first { !initial.contains(ObjectIdentifier($0)) && $0.isVisible && $0.title == "YCoding Chrome Profile" }
                    if let id = shown.flatMap({ UInt32(exactly: $0.windowNumber) }), WindowHost.elevatedWindowVisible(id, owner: getpid()) { break }
                    try await Task.sleep(for: .milliseconds(20))
                }
                let window = try XCTUnwrap(shown)
                let labels = window.contentView?.subviews.compactMap { $0 as? NSTextField }.map(\.stringValue) ?? []
                XCTAssertTrue(labels.contains("Profile: Work"))
                XCTAssertTrue(labels.contains("Match code: K7Q2-M9"))
                XCTAssertFalse(NSApplication.shared.isActive)
                if choice == "close" {
                    window.performClose(nil)
                } else {
                    try XCTUnwrap(window.contentView?.subviews.compactMap { $0 as? NSButton }.first { $0.title == choice }).performClick(nil)
                }
                let approved = await decision.value
                XCTAssertEqual(approved, expected, choice)
                XCTAssertFalse(window.isVisible)
            }
        }
    }

    @MainActor
    private func runPanelScenario(_ body: @escaping @MainActor (NSApplication, Set<ObjectIdentifier>) async throws -> Void) throws {
        let application = NSApplication.shared
        _ = application.setActivationPolicy(.accessory)
        XCTAssertEqual(application.activationPolicy(), .accessory)
        XCTAssertFalse(application.isRunning)
        var settled = false
        Task { @MainActor in
            defer {
                settled = true
                application.stop(nil)
                if let wake = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0,
                    windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0) {
                    application.postEvent(wake, atStart: true)
                }
            }
            do { try await body(application, Set(application.windows.map { ObjectIdentifier($0) })) } catch { XCTFail("\(error)") }
        }
        application.run()
        XCTAssertTrue(settled)
    }

    @MainActor
    func testLiveBackgroundActionsApplyAndForegroundNeedsPauseUntilResume() throws {
        guard AXIsProcessTrusted() else { throw Refusal.permissionMissing }
        let target = try liveFixture()
        try runPanelScenario { application, initial in
            let fence = InteractionFence()
            let lease = try fence.begin(target)
            var resumes = 0
            var dispatches = 0
            let panel = try XCTUnwrap(ControlPanel(app: "Synthetic", scope: "Window \(target.windowID)", stop: {}, resume: { resumes += 1 }))
            try fence.activate(lease, target: target, visible: true)
            let window = try XCTUnwrap(application.windows.first { !initial.contains(ObjectIdentifier($0)) })
            let resume = try XCTUnwrap(window.contentView?.subviews.compactMap { $0 as? NSButton }.first { $0.title == "Resume" })

            @MainActor func act(_ action: String, _ label: String? = nil, text: String? = nil, deltaY: Int? = nil) throws {
                try fence.check(lease, target: target)
                let read = try WindowHost.observe(target)
                try fence.observed(lease, target: target, revision: read.revision)
                let controlID = try label.map { name in try XCTUnwrap(read.controls.first { $0.label.hasPrefix(name) && $0.actions.contains(action) }, name).id }
                try WindowHost.perform(target, revision: read.revision, controlID: controlID, action: action, text: text, deltaY: deltaY) {
                    try fence.dispatch(lease, target: target, revision: read.revision)
                    dispatches += 1
                }
            }
            @MainActor func filterAttempts() -> String? {
                Self.axElement(target.pid) { $0.role == "AXStaticText" && $0.value.hasPrefix("Filter value attempts") }?.value
            }
            @MainActor func blocked() async throws -> Refusal? {
                let deadline = ContinuousClock.now.advanced(by: .seconds(2))
                while ContinuousClock.now < deadline {
                    do { _ = try WindowHost.observe(target) } catch { return error as? Refusal }
                    try await Task.sleep(for: .milliseconds(50))
                }
                return nil
            }
            @MainActor func cleared() async throws -> WindowRead {
                let deadline = ContinuousClock.now.advanced(by: .seconds(2))
                while true {
                    do { return try WindowHost.observe(target) } catch {
                        guard ContinuousClock.now < deadline else { throw error }
                    }
                    try await Task.sleep(for: .milliseconds(50))
                }
            }
            @MainActor func pause(_ refusal: Refusal?, expected: PauseReason, recover: () throws -> Void) async throws {
                let reason = try XCTUnwrap(PauseReason(try XCTUnwrap(refusal)))
                XCTAssertEqual(reason, expected)
                try fence.pause(lease, target: target, reason: reason)
                panel.pause(reason)
                XCTAssertFalse(resume.isHidden)
                XCTAssertThrowsError(try fence.check(lease, target: target)) { XCTAssertEqual($0 as? Refusal, .paused) }
                XCTAssertThrowsError(try act("press", "Increment count")) { XCTAssertEqual($0 as? Refusal, .paused) }
                Self.artifact("pause-\(reason.rawValue)-target", window: Int(target.windowID))
                try recover()
                let read = try await cleared()
                let before = resumes
                resume.performClick(nil)
                XCTAssertEqual(resumes, before + 1)
                try fence.resume(lease, target: target)
                panel.resume()
                XCTAssertTrue(resume.isHidden)
                XCTAssertNoThrow(try fence.observed(lease, target: target, revision: read.revision))
            }

            try act("press", "Increment count")
            XCTAssertEqual(Self.axElement(target.pid) { $0.role == "AXButton" && $0.title.hasPrefix("Increment count") }?.title, "Increment count: 1")
            try act("replaceText", "Search", text: "Background value")
            XCTAssertEqual(Self.axElement(target.pid) { $0.role == "AXTextField" && $0.description == "Search" }?.value, "Background value")
            try act("scroll", deltaY: 300)
            XCTAssertEqual(Double(Self.axElement(target.pid) { $0.role == "AXScrollBar" }?.value ?? "") ?? -1, 0.3, accuracy: 0.001)

            XCTAssertEqual(filterAttempts(), "Filter value attempts: 0")
            try await Self.phase("foreground-before")
            let dispatchedBefore = dispatches
            try await Self.phase("foreground-attempt", settle: false)
            var refusal: Refusal?
            do { try act("replaceText", "Filter", text: "Needs focus") } catch { refusal = error as? Refusal }
            XCTAssertEqual(dispatches, dispatchedBefore + 1)
            XCTAssertEqual(filterAttempts(), "Filter value attempts: 1")
            try await Self.phase("foreground-paused")
            try await pause(refusal, expected: .foregroundRequired) {}
            XCTAssertEqual(dispatches, dispatchedBefore + 1)
            XCTAssertEqual(filterAttempts(), "Filter value attempts: 1")
            XCTAssertEqual(Self.axElement(target.pid) { $0.role == "AXTextField" && $0.description == "Filter" }?.value, "")
            try await Self.phase("foreground-after")
            try await Self.phase("during-xctest", settle: false)

            try act("press", "Show sign-in field")
            try await pause(try await blocked(), expected: .sensitive) {
                try Self.axPress(target.pid) { $0.role == "AXButton" && $0.title == "Show sign-in field" }
            }

            try act("press", "Show dialog")
            try await pause(try await blocked(), expected: .dialog) {
                try Self.axPress(target.pid) { $0.role == "AXButton" && $0.title == "Dismiss" }
            }
            XCTAssertEqual(resumes, 3)
            XCTAssertTrue(fence.stop(lease))
        }
    }

    private func liveFixture() throws -> InteractionTarget {
        let identity = try XCTUnwrap(ProcessInfo.processInfo.environment["YCODING_TEST_MACOS_INTERACTION_FIXTURE"])
            .split(separator: "/", omittingEmptySubsequences: false)
        guard identity.count == 2, let pid = Int32(identity[0]), let windowID = UInt32(identity[1]) else {
            throw Refusal.invalidRequest
        }
        return try XCTUnwrap(try WindowHost.inventory().first {
            $0.target.pid == pid && $0.target.windowID == windowID && $0.target.bundleID == "local.synthetic.ycoding.InteractionFixture"
        }).target
    }

    private struct AXNode {
        let element: AXUIElement
        let role: String
        let title: String
        let description: String
        let value: String
    }

    private static func axElement(_ pid: Int32, _ matches: (AXNode) -> Bool) -> AXNode? {
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
        }
        var queue = attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement] ?? []
        while !queue.isEmpty {
            let element = queue.removeFirst()
            let value = attribute(element, kAXValueAttribute).map { "\($0)" } ?? ""
            let node = AXNode(element: element, role: attribute(element, kAXRoleAttribute) as? String ?? "",
                title: attribute(element, kAXTitleAttribute) as? String ?? "", description: attribute(element, kAXDescriptionAttribute) as? String ?? "",
                value: value)
            if matches(node) { return node }
            queue.append(contentsOf: attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [])
        }
        return nil
    }

    private static func axPress(_ pid: Int32, _ matches: (AXNode) -> Bool) throws {
        let node = try XCTUnwrap(Self.axElement(pid, matches))
        XCTAssertEqual(AXUIElementPerformAction(node.element, kAXPressAction as CFString), .success)
    }

    private static func phase(_ name: String, settle: Bool = true) async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let directory = environment["YCODING_TEST_MACOS_INTERACTION_ARTIFACTS"],
              let mode = environment["YCODING_TEST_MACOS_INTERACTION_MODE"] else { return }
        let labels = open("\(directory)/labels", O_WRONLY | O_NONBLOCK)
        guard labels >= 0 else { throw Refusal.unavailable }
        defer { close(labels) }
        let label = Array("\(mode):\(name)\n".utf8)
        guard write(labels, label, label.count) == label.count else { throw Refusal.unavailable }
        let marks = try FileHandle(forWritingTo: URL(fileURLWithPath: "\(directory)/marks.log"))
        try marks.seekToEnd()
        try marks.write(contentsOf: Data("\(mode) \(name) \(Int(Date().timeIntervalSince1970 * 1000))\n".utf8))
        try marks.close()
        if settle { try await Task.sleep(for: .milliseconds(300)) }
    }

    private static func artifact(_ name: String, window: Int) {
        guard let directory = ProcessInfo.processInfo.environment["YCODING_TEST_MACOS_INTERACTION_ARTIFACTS"] else { return }
        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-l", String(window), "-o", "-x", "\(directory)/\(name).png"]
        guard (try? capture.run()) != nil else { return }
        capture.waitUntilExit()
    }

    func testSensitiveOrUnverifiedElementsAreNotActionable() {
        XCTAssertTrue(WindowSafety.sensitive(role: "AXSecureTextField", description: "Login"))
        XCTAssertTrue(WindowSafety.sensitive(role: "AXButton", description: "Solve CAPTCHA"))
        XCTAssertTrue(WindowSafety.sensitive(role: "AXTextField", description: "One-time code"))
        XCTAssertFalse(WindowSafety.canReplace(role: "AXTextField", description: "", enabled: true, writable: true))
        XCTAssertFalse(WindowSafety.canReplace(role: "AXTextField", description: "Search", enabled: true, writable: false))
        XCTAssertTrue(WindowSafety.canReplace(role: "AXTextField", description: "Search", enabled: true, writable: true))
        XCTAssertFalse(WindowSafety.allowedApp("com.google.Chrome.beta"))
        XCTAssertFalse(WindowSafety.allowedApp("app.ycoding.interaction"))
    }

    func testPreviewFitsThePixelEnvelopeWithoutRotatingOrUpscaling() {
        XCTAssertEqual(WindowHost.previewSize(CGSize(width: 1920, height: 1080)), CGSize(width: 960, height: 540))
        XCTAssertEqual(WindowHost.previewSize(CGSize(width: 1080, height: 1920)), CGSize(width: 405, height: 720))
        XCTAssertEqual(WindowHost.previewSize(CGSize(width: 640, height: 480)), CGSize(width: 640, height: 480))
        XCTAssertNil(WindowHost.previewSize(CGSize(width: CGFloat.infinity, height: 480)))
        XCTAssertNil(WindowHost.previewSize(CGSize(width: 640, height: 0)))
    }

    func testPreviewHasItsOwnExactWindowFenceBeforeAndAfterInput() async throws {
        let fence = InteractionFence()
        let lease = try fence.begin(window)
        try fence.activate(lease, target: window, visible: true)

        let attached = try await fence.capture(lease, target: window) { verify in
            try verify()
            return "synthetic attached frame"
        }
        XCTAssertEqual(attached.frame, "synthetic attached frame")
        XCTAssertThrowsError(try fence.dispatch(lease, target: window, revision: "input")) { XCTAssertEqual($0 as? Refusal, .staleRevision) }
        try fence.observed(lease, target: window, revision: "input")
        try fence.dispatch(lease, target: window, revision: "input")
        XCTAssertThrowsError(try attached.verify()) { XCTAssertEqual($0 as? Refusal, .staleRevision) }

        let applied = try await fence.capture(lease, target: window) { verify in
            try verify()
            return "synthetic applied frame"
        }
        XCTAssertEqual(applied.frame, "synthetic applied frame")
        XCTAssertThrowsError(try fence.dispatch(lease, target: window, revision: "input")) { XCTAssertEqual($0 as? Refusal, .staleRevision) }

        try fence.observed(lease, target: window, revision: "next input")
        do {
            _ = try await fence.capture(lease, target: window) { verify in
                try verify()
                try fence.dispatch(lease, target: window, revision: "next input")
                return "synthetic late frame"
            }
            XCTFail("An intervening input released an old frame")
        } catch { XCTAssertEqual(error as? Refusal, .staleRevision) }

        let otherWindow = InteractionTarget(pid: window.pid, started: window.started, bundleID: window.bundleID, windowID: window.windowID + 1)
        do {
            _ = try await fence.capture(lease, target: otherWindow) { _ in
                XCTFail("A different window reached capture")
            }
            XCTFail("A different window produced a frame")
        } catch { XCTAssertEqual(error as? Refusal, .targetChanged) }
        let beforeStop = try await fence.capture(lease, target: window) { _ in "synthetic frame before Stop" }
        XCTAssertTrue(fence.stop(lease))
        XCTAssertThrowsError(try beforeStop.verify()) { XCTAssertEqual($0 as? Refusal, .stopped) }
    }

    func testLivePreviewCapturesTheSyntheticWindowBeforeObservationAndAfterInput() async throws {
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { throw Refusal.permissionMissing }
        let identity = try XCTUnwrap(ProcessInfo.processInfo.environment["YCODING_TEST_MACOS_INTERACTION_FIXTURE"])
            .split(separator: "/", omittingEmptySubsequences: false)
        guard identity.count == 2, let pid = Int32(identity[0]), let windowID = UInt32(identity[1]) else {
            XCTFail("Synthetic fixture identity must be its exact PID/window ID")
            return
        }
        let app = NSRunningApplication(processIdentifier: pid)
        let metadata = (CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]])?.first
        let diagnostic = "Synthetic fixture: registered=\(app != nil), bundleMatches=\(app?.bundleIdentifier == "local.synthetic.ycoding.InteractionFixture"), windowListed=\(metadata != nil), ownerMatches=\(metadata?[kCGWindowOwnerPID as String] as? Int32 == pid), layerZero=\(metadata?[kCGWindowLayer as String] as? Int == 0), onscreen=\(metadata?[kCGWindowIsOnscreen as String] as? Bool == true)"
        let target = try XCTUnwrap(try WindowHost.inventory().first {
            $0.target.pid == pid && $0.target.windowID == windowID && $0.target.bundleID == "local.synthetic.ycoding.InteractionFixture"
        }, diagnostic).target
        let fence = InteractionFence()
        let lease = try fence.begin(target)
        try fence.activate(lease, target: target, visible: true)

        let before = try await fence.capture(lease, target: target) { verify in
            try await WindowHost.preview(target, verify: verify)
        }
        let beforeImage = try XCTUnwrap(Data(base64Encoded: before.frame.image).flatMap(NSBitmapImageRep.init(data:)))
        XCTAssertEqual(beforeImage.pixelsWide, before.frame.width)
        XCTAssertEqual(beforeImage.pixelsHigh, before.frame.height)

        let observation = try WindowHost.observe(target)
        let search = try XCTUnwrap(observation.controls.first { $0.label == "Search" && $0.actions.contains("replaceText") })
        try fence.observed(lease, target: target, revision: observation.revision)
        try WindowHost.perform(target, revision: observation.revision, controlID: search.id,
            action: "replaceText", text: "Synthetic preview update", deltaY: nil) {
            try fence.dispatch(lease, target: target, revision: observation.revision)
        }
        let after = try await fence.capture(lease, target: target) { verify in
            try await WindowHost.preview(target, verify: verify)
        }
        let afterImage = try XCTUnwrap(Data(base64Encoded: after.frame.image).flatMap(NSBitmapImageRep.init(data:)))
        XCTAssertEqual(afterImage.pixelsWide, after.frame.width)
        XCTAssertEqual(afterImage.pixelsHigh, after.frame.height)
        XCTAssertNotEqual(before.frame.image, after.frame.image)
        XCTAssertThrowsError(try fence.dispatch(lease, target: target, revision: observation.revision)) {
            XCTAssertEqual($0 as? Refusal, .staleRevision)
        }
    }

    func testIsolatedConsentCannotSettleAfterExpiryOrReplacement() {
        let first = IsolatedConsentRequest(candidateID: UUID(), sessionID: "ses_synthetic", url: "https://example.test/first?q=1", expiresAt: 1000)
        let another = IsolatedConsentRequest(candidateID: UUID(), sessionID: first.sessionID, url: "https://example.test/second", expiresAt: 1100)
        let credentialed = IsolatedConsentRequest(candidateID: UUID(), sessionID: first.sessionID, url: "https://synthetic@example.test/", expiresAt: 1000)
        var expiring = IsolatedConsentFence()
        XCTAssertFalse(expiring.begin(credentialed, now: 700))
        XCTAssertFalse(expiring.begin(first, now: 1000))
        XCTAssertTrue(expiring.begin(first, now: 700))
        XCTAssertFalse(expiring.finish(first, visible: true, now: 1000))

        var replaced = IsolatedConsentFence()
        XCTAssertTrue(replaced.begin(first, now: 700))
        XCTAssertFalse(replaced.begin(another, now: 800))
        XCTAssertFalse(replaced.finish(first, visible: true, now: 900))
        XCTAssertFalse(replaced.finish(another, visible: true, now: 900))

        var approved = IsolatedConsentFence()
        XCTAssertTrue(approved.begin(first, now: 700))
        XCTAssertTrue(approved.finish(first, visible: true, now: 900))
        XCTAssertFalse(approved.finish(first, visible: true, now: 901))
    }

    func testIsolatedStopMustBeVisibleAndBindOnceBeforeTheCandidateExpires() {
        let request = IsolatedConsentRequest(candidateID: UUID(), sessionID: "ses_synthetic", url: "https://example.test/", expiresAt: 1000)
        let lease = UUID()
        var hidden = IsolatedConsentFence()
        XCTAssertTrue(hidden.begin(request, now: 700))
        XCTAssertFalse(hidden.finish(request, visible: false, now: 800))
        XCTAssertFalse(hidden.bind(candidateID: request.candidateID, lease: lease, now: 900))

        var expired = IsolatedConsentFence()
        XCTAssertTrue(expired.begin(request, now: 700))
        XCTAssertTrue(expired.finish(request, visible: true, now: 800))
        XCTAssertFalse(expired.bind(candidateID: request.candidateID, lease: lease, now: 1000))

        var stopped = IsolatedConsentFence()
        XCTAssertTrue(stopped.begin(request, now: 700))
        XCTAssertTrue(stopped.finish(request, visible: true, now: 800))
        XCTAssertEqual(stopped.stop(), request.candidateID)
        XCTAssertFalse(stopped.bind(candidateID: request.candidateID, lease: lease, now: 900))

        var active = IsolatedConsentFence()
        XCTAssertTrue(active.begin(request, now: 700))
        XCTAssertTrue(active.finish(request, visible: true, now: 800))
        XCTAssertFalse(active.bind(candidateID: UUID(), lease: lease, now: 900))
        XCTAssertTrue(active.bind(candidateID: request.candidateID, lease: lease, now: 900))
        XCTAssertFalse(active.bind(candidateID: request.candidateID, lease: UUID(), now: 901))
        XCTAssertTrue(active.live(now: 1000))
        XCTAssertEqual(active.stop(), lease)
        XCTAssertFalse(active.live(now: 1001))
    }

    @MainActor
    func testNativeStopPanelDispatchesItsBoundHandler() throws {
        try runPanelScenario { application, initial in
            var stops = 0
            let panel = try XCTUnwrap(ControlPanel(app: "Isolated Chrome", scope: "example.test", stop: { stops += 1 }))
            defer { panel.hide() }
            let shown = await panel.show()
            XCTAssertTrue(shown)
            XCTAssertTrue(panel.visible)
            let window = try XCTUnwrap(application.windows.first { !initial.contains(ObjectIdentifier($0)) && $0.isVisible })
            let id = try XCTUnwrap(UInt32(exactly: window.windowNumber))
            let stop = try XCTUnwrap(window.contentView?.subviews.compactMap { $0 as? NSButton }.first { $0.title == "Stop" })
            XCTAssertTrue(WindowHost.elevatedWindowVisible(id, owner: getpid()))
            stop.performClick(nil)
            XCTAssertEqual(stops, 1)
            panel.hide()
            XCTAssertFalse(panel.visible)
        }
    }

    func testChooserReturnsOnlyAnOfferedTargetBeforeTheDeadline() {
        let offered = WindowChoice(id: UUID(), target: window)
        let request = WindowChoiceRequest(candidateID: UUID(), sessionID: "ses_synthetic", expiresAt: 1000, windows: [offered])
        XCTAssertEqual(request.selection(offered.id, now: 999), window)
        XCTAssertNil(request.selection(offered.id, now: 1000))
        XCTAssertNil(request.selection(UUID(), now: 999))
        let duplicate = WindowChoiceRequest(candidateID: UUID(), sessionID: request.sessionID, expiresAt: 1000, windows: [offered, offered])
        XCTAssertNil(duplicate.selection(offered.id, now: 999))
    }

    @MainActor
    func testElevatedVisibilityRecognizesOnlyTheExactLiveOwnedPanel() async throws {
        _ = NSApplication.shared
        let frame = NSRect(x: 24, y: 24, width: 96, height: 64)
        let fixture = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
        let panel = NSPanel(contentRect: frame.offsetBy(dx: 110, dy: 0), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        fixture.isReleasedWhenClosed = false
        panel.isReleasedWhenClosed = false
        panel.level = .statusBar
        panel.sharingType = .none
        fixture.orderFrontRegardless()
        panel.orderFrontRegardless()
        defer { panel.close(); fixture.close() }
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }

        let ordinary = try XCTUnwrap(UInt32(exactly: fixture.windowNumber))
        let elevated = try XCTUnwrap(UInt32(exactly: panel.windowNumber))
        XCTAssertNotEqual(ordinary, elevated)
        XCTAssertFalse(WindowHost.elevatedWindowVisible(ordinary, owner: getpid()))
        XCTAssertFalse(WindowHost.elevatedWindowVisible(elevated, owner: getppid()))
        XCTAssertTrue(WindowHost.elevatedWindowVisible(elevated, owner: getpid()))

        panel.orderOut(nil)
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        XCTAssertFalse(WindowHost.elevatedWindowVisible(elevated, owner: getpid()))
    }
}
