import AppKit
import ApplicationServices
import CryptoKit
import ScreenCaptureKit

struct TargetLabel: Codable, Sendable {
    let target: InteractionTarget
    let label: String
}

struct WindowControl: Codable, Sendable {
    let id: String
    let role: String
    let label: String
    let actions: [String]
}

struct WindowRead: Codable, Sendable {
    let revision: String
    let controls: [WindowControl]
}

struct WindowImage: Codable, Sendable {
    let image: String
    let width: Int
    let height: Int
}

enum WindowHost {
    private static let revisionSalt = UUID().uuidString
    private typealias AXWindowID = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    private static let idForElement: AXWindowID? = {
        guard let library = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY | RTLD_LOCAL),
              let symbol = dlsym(library, "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(symbol, to: AXWindowID.self)
    }()

    static func awake() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              session["kCGSSessionOnConsoleKey"] as? Bool == true else { return false }
        return session["CGSSessionScreenIsLocked"] as? Bool != true
    }

    private static func processIdentity(_ pid: Int32) -> String? {
        guard pid > 1 else { return nil }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_start_tvsec > 0 else { return nil }
        return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
    }

    private static func describe(_ info: [String: Any]) -> (TargetLabel, CGRect, String)? {
        guard info[kCGWindowLayer as String] as? Int == 0,
              let pid = info[kCGWindowOwnerPID as String] as? Int32,
              let windowID = info[kCGWindowNumber as String] as? UInt32, windowID > 0,
              let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated, !application.isHidden,
              let bundleID = application.bundleIdentifier, WindowSafety.allowedApp(bundleID),
              let started = processIdentity(pid),
              let dictionary = info[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
              bounds.width.isFinite, bounds.height.isFinite, bounds.width >= 1, bounds.height >= 1 else { return nil }
        let target = InteractionTarget(pid: pid, started: started, bundleID: bundleID, windowID: windowID)
        let label = String((application.localizedName ?? bundleID).prefix(100))
        let title = String((info[kCGWindowName as String] as? String ?? "").prefix(160))
        return (TargetLabel(target: target, label: label), bounds, title)
    }

    static func inventory() throws -> [TargetLabel] {
        guard awake() else { throw Refusal.unavailable }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw Refusal.unavailable
        }
        return windows.lazy.compactMap { describe($0)?.0 }.prefix(64).map { $0 }
    }

    private static func window(_ target: InteractionTarget) throws -> (TargetLabel, CGRect, String) {
        guard awake() else { throw Refusal.unavailable }
        guard WindowSafety.allowedApp(target.bundleID) else { throw Refusal.sensitive }
        guard let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, target.windowID) as? [[String: Any]],
              windows.count == 1, let details = describe(windows[0]), details.0.target == target else { throw Refusal.targetChanged }
        guard !WindowSafety.sensitive(role: "AXWindow", description: details.2) else { throw Refusal.sensitive }
        return details
    }

    static func consentDescription(_ target: InteractionTarget) throws -> (app: String, title: String) {
        let details = try window(target)
        return (details.0.label, details.2.isEmpty ? "Window \(target.windowID)" : details.2)
    }

    static func verifyTarget(_ target: InteractionTarget) throws {
        _ = try window(target)
    }

    static func elevatedWindowVisible(_ id: CGWindowID, owner: pid_t) -> Bool {
        guard id != kCGNullWindowID, awake(),
              let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
              windows.count == 1, let window = windows.first,
              window[kCGWindowNumber as String] as? CGWindowID == id,
              window[kCGWindowOwnerPID as String] as? pid_t == owner,
              let layer = window[kCGWindowLayer as String] as? Int, layer > 0 else { return false }
        return window[kCGWindowIsOnscreen as String] as? Bool == true
    }

    private struct Snapshot {
        let result: WindowRead
        let actions: [String: AXUIElement]
        let scrollbars: [AXUIElement]
        let bounds: CGRect
    }

    private static func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func snapshot(_ target: InteractionTarget) throws -> Snapshot {
        let details = try window(target)
        guard AXIsProcessTrusted() else { throw Refusal.permissionMissing }
        guard let idForElement else { throw Refusal.unsupported }
        let app = AXUIElementCreateApplication(target.pid)
        guard AXUIElementSetMessagingTimeout(app, 0.2) == .success,
              let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { throw Refusal.unverified }
        let matching = windows.filter { element in
            var id: CGWindowID = 0
            return idForElement(element, &id) == .success && id == target.windowID
        }
        guard matching.count == 1, let root = matching.first else { throw Refusal.unverified }
        guard !windows.contains(where: { !CFEqual($0, root) && attribute($0, "AXModal") as? Bool == true }) else { throw Refusal.dialog }

        var nodes = [(root, "0", 0)]
        var cursor = 0
        var controls: [WindowControl] = []
        var actions: [String: AXUIElement] = [:]
        var scrollbars: [AXUIElement] = []
        let fingerprint = JSONEncoder()
        fingerprint.outputFormatting = [.sortedKeys]
        var hash = SHA256()
        hash.update(data: Data(revisionSalt.utf8))
        hash.update(data: try fingerprint.encode(target))
        hash.update(data: Data(String(describing: details.1).utf8))
        hash.update(data: Data(details.2.utf8))
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while cursor < nodes.count {
            guard nodes.count <= 320, ContinuousClock.now < deadline else { throw Refusal.unverified }
            let (element, id, depth) = nodes[cursor]
            cursor += 1
            guard let role = attribute(element, kAXRoleAttribute) as? String else { throw Refusal.unverified }
            guard role != "AXSheet" else { throw Refusal.dialog }
            let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
            let names = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute, "AXPlaceholderValue"]
                .compactMap { attribute(element, $0) as? String }
                .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            guard !names.contains(where: { $0.localizedCaseInsensitiveContains("captcha") }) else { throw Refusal.captcha }
            guard !names.contains(where: { WindowSafety.sensitive(role: role, description: $0) }),
                  !WindowSafety.sensitive(role: role, description: ""),
                  !WindowSafety.sensitive(role: subrole, description: "") else { throw Refusal.sensitive }
            guard role != "AXWebArea" else { throw Refusal.unsupported }
            let name = String((names.first ?? "").prefix(120))
            let enabled = (attribute(element, kAXEnabledAttribute) as? Bool) == true
            var available: CFArray?
            var writable = DarwinBoolean(false)
            let advertised = AXUIElementCopyActionNames(element, &available) == .success
                && (available as? [String])?.contains(kAXPressAction) == true
            let settable = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success && writable.boolValue
            var allowed: [String] = []
            if WindowSafety.canPress(role: role, description: name, enabled: enabled, advertised: advertised) { allowed.append("press") }
            if WindowSafety.canReplace(role: role, description: name, enabled: enabled, writable: settable) { allowed.append("replaceText") }
            let control = WindowControl(id: id, role: role, label: name, actions: allowed)
            hash.update(data: try fingerprint.encode(control))
            if !allowed.isEmpty, controls.count < 200 {
                controls.append(control)
                actions[id] = element
            }
            if allowed.contains("replaceText"), let value = attribute(element, kAXValueAttribute) as? String {
                guard value.utf8.count <= 16_384 else { throw Refusal.unverified }
                hash.update(data: try fingerprint.encode(value))
            }
            if role == "AXScrollBar", enabled, settable,
               attribute(element, kAXOrientationAttribute) as? String == "AXVerticalOrientation",
               let current = attribute(element, kAXValueAttribute) as? NSNumber,
               current.doubleValue.isFinite, (0...1).contains(current.doubleValue) {
                hash.update(data: try fingerprint.encode(current.doubleValue))
                scrollbars.append(element)
            }
            var children: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
            if status == .success {
                guard let children = children as? [AXUIElement], children.isEmpty || depth < 16,
                      nodes.count + children.count <= 320 else { throw Refusal.unverified }
                nodes.append(contentsOf: children.enumerated().map { ($0.element, "\(id).\($0.offset)", depth + 1) })
            } else if status != .attributeUnsupported && status != .noValue {
                throw Refusal.unverified
            }
        }
        try verifyTarget(target)
        let revision = hash.finalize().map { String(format: "%02x", $0) }.joined()
        return Snapshot(result: WindowRead(revision: revision, controls: controls), actions: actions, scrollbars: scrollbars, bounds: details.1)
    }

    static func observe(_ target: InteractionTarget) throws -> WindowRead {
        try snapshot(target).result
    }

    static func confirm(_ target: InteractionTarget, revision: String, controlID: String, action: String) throws -> String {
        let state = try snapshot(target)
        guard state.result.revision == revision else { throw Refusal.staleRevision }
        guard let control = state.result.controls.first(where: { $0.id == controlID }),
              control.actions.contains(action) else { throw Refusal.unverified }
        return control.label
    }

    static func perform(_ target: InteractionTarget, revision: String, controlID: String?, action: String, text: String?, deltaY: Int?, admit: () throws -> Void) throws {
        let state = try snapshot(target)
        guard state.result.revision == revision else { throw Refusal.staleRevision }
        if action == "scroll" {
            guard controlID == nil, text == nil, let deltaY, deltaY != 0, (-10_000...10_000).contains(deltaY) else { throw Refusal.invalidRequest }
            guard state.scrollbars.count == 1, let bar = state.scrollbars.first,
                  let current = attribute(bar, kAXValueAttribute) as? NSNumber,
                  current.doubleValue.isFinite, (0...1).contains(current.doubleValue) else { throw Refusal.unsupported }
            let next = min(1, max(0, current.doubleValue + Double(deltaY) / 1_000))
            try send(target, admit: admit) { AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next)) }
            return
        }
        guard deltaY == nil, let controlID, let control = state.result.controls.first(where: { $0.id == controlID }),
              let element = state.actions[controlID], control.actions.contains(action) else { throw Refusal.unverified }
        let value = text ?? ""
        if action == "replaceText" {
            guard text != nil, value.utf16.count <= 4096, value.utf8.count <= 16_384,
                  value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { throw Refusal.invalidRequest }
        } else if action != "press" || text != nil { throw Refusal.invalidRequest }
        let before = attribute(element, kAXValueAttribute) as? String
        try send(target, admit: admit) {
            action == "press" ? AXUIElementPerformAction(element, kAXPressAction as CFString)
                : AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
        }
        if action == "replaceText", let before, before != value, attribute(element, kAXValueAttribute) as? String == before {
            throw Refusal.foregroundRequired
        }
    }

    private static func send(_ target: InteractionTarget, admit: () throws -> Void, action: () -> AXError) throws {
        try verifyTarget(target)
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        try admit()
        let status = action()
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == front else { throw Refusal.uncertain }
        guard ![.actionUnsupported, .attributeUnsupported, .notImplemented].contains(status) else { throw Refusal.foregroundRequired }
        guard status == .success else { throw Refusal.uncertain }
    }

    static func previewSize(_ size: CGSize) -> CGSize? {
        guard size.width.isFinite, size.height.isFinite, size.width >= 1, size.height >= 1 else { return nil }
        let scale = min(1, 960 / size.width, 720 / size.height)
        return CGSize(width: max(1, Int(size.width * scale)), height: max(1, Int(size.height * scale)))
    }

    static func preview(_ target: InteractionTarget, verify: PreviewFence) async throws -> WindowImage {
        try verify()
        try verifyTarget(target)
        guard CGPreflightScreenCaptureAccess() else { throw Refusal.permissionMissing }
        let shareable = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        try verify()
        let windows = shareable.windows.filter {
            $0.windowID == target.windowID && $0.owningApplication?.processID == target.pid
                && $0.owningApplication?.bundleIdentifier == target.bundleID
        }
        guard windows.count == 1, let window = windows.first else { throw Refusal.targetChanged }
        let before = try snapshot(target)
        guard window.frame.size == before.bounds.size else { throw Refusal.unavailable }
        guard let size = previewSize(before.bounds.size) else { throw Refusal.unavailable }
        let config = SCStreamConfiguration()
        config.width = Int(size.width)
        config.height = Int(size.height)
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        try verify()
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
        try verify()
        guard image.width == config.width, image.height == config.height else { throw Refusal.unavailable }
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let jpeg = [0.5, 0.3, 0.2].lazy.compactMap({ bitmap.representation(using: .jpeg, properties: [.compressionFactor: $0]) })
            .first(where: { $0.count <= 160 * 1024 }) else { throw Refusal.unavailable }
        guard try snapshot(target).result.revision == before.result.revision else { throw Refusal.staleRevision }
        return WindowImage(image: jpeg.base64EncodedString(), width: image.width, height: image.height)
    }
}
