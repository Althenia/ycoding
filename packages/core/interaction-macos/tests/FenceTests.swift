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
        let application = NSApplication.shared
        XCTAssertTrue(application.setActivationPolicy(.accessory))
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
            let initial = Set(application.windows.map { ObjectIdentifier($0) })
            var stops = 0
            guard let panel = try? XCTUnwrap(ControlPanel(app: "Isolated Chrome", scope: "example.test", stop: { stops += 1 })) else { return }
            defer { panel.hide() }
            let shown = await panel.show()
            XCTAssertTrue(shown)
            XCTAssertTrue(panel.visible)
            guard let window = try? XCTUnwrap(application.windows.first { !initial.contains(ObjectIdentifier($0)) && $0.isVisible }),
                  let id = try? XCTUnwrap(UInt32(exactly: window.windowNumber)),
                  let stop = try? XCTUnwrap(window.contentView?.subviews.compactMap { $0 as? NSButton }.first { $0.title == "Stop" }) else { return }
            XCTAssertTrue(WindowHost.enrollmentWindowVisible(id, owner: getpid()))
            stop.performClick(nil)
            XCTAssertEqual(stops, 1)
            panel.hide()
            XCTAssertFalse(panel.visible)
        }
        application.run()
        XCTAssertTrue(settled)
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

    func testEnrollmentRequiresAValidUnexpiredLoopbackRequest() {
        let enrollment = ChromeEnrollmentRequest(origin: "http://127.0.0.1:5314", code: String(repeating: "A", count: 43), expiresAt: 1000)
        XCTAssertTrue(enrollment.valid(now: 999))
        XCTAssertFalse(enrollment.valid(now: 1000))
        let remote = ChromeEnrollmentRequest(origin: "https://example.test", code: enrollment.code, expiresAt: 1000)
        XCTAssertFalse(remote.valid(now: 999))
    }

    func testEnrollmentIntentRequiresLocalAuthenticationAndOneExactOffer() {
        let first = UUID()
        let second = UUID()
        var fence = ChromeEnrollmentIntentFence()
        XCTAssertFalse(fence.claim(first, now: 10))
        XCTAssertTrue(fence.select(first))
        XCTAssertFalse(fence.select(second))
        XCTAssertFalse(fence.claim(first, now: 10))
        XCTAssertNil(fence.authenticate(first, approved: false, now: 10))
        XCTAssertFalse(fence.claim(first, now: 10))

        XCTAssertTrue(fence.select(second))
        let deadline = fence.authenticate(second, approved: true, now: 20)
        XCTAssertNotNil(deadline)
        XCTAssertFalse(fence.claim(first, now: 21))
        XCTAssertTrue(fence.claim(second, now: 21))
        XCTAssertFalse(fence.claim(second, now: 22))
        XCTAssertFalse(fence.retire(first))
        XCTAssertTrue(fence.retire(second))
        XCTAssertFalse(fence.retire(second))

        let expired = UUID()
        XCTAssertTrue(fence.select(expired))
        guard let expires = fence.authenticate(expired, approved: true, now: 30) else { return XCTFail("Missing authenticated intent") }
        XCTAssertFalse(fence.claim(expired, now: expires))
        XCTAssertTrue(fence.retire(expired))
    }

    @MainActor
    func testEnrollmentRecognizesOnlyTheExactLiveElevatedPanel() async throws {
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
        XCTAssertFalse(WindowHost.enrollmentWindowVisible(ordinary, owner: getpid()))
        XCTAssertFalse(WindowHost.enrollmentWindowVisible(elevated, owner: getppid()))
        XCTAssertTrue(WindowHost.enrollmentWindowVisible(elevated, owner: getpid()))

        panel.orderOut(nil)
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        XCTAssertFalse(WindowHost.enrollmentWindowVisible(elevated, owner: getpid()))
    }
}
