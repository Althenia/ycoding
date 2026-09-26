import AppKit
import ApplicationServices
import Carbon
import CryptoKit
import Foundation
import CoreGraphics
import ScreenCaptureKit
import Darwin

private struct Owner: Decodable {
    let sessionID: String
    let callID: String
}

private struct ItermTarget: Decodable {
    let platform: String
    let application: String
    let windowID: Int32
    let tabIndex: Int32
    let sessionID: String
}

private struct FinderTarget: Decodable {
    let platform: String
    let application: String
    let path: String
}
private struct DesktopTarget: Decodable {
    let platform: String
    let application: String
    let bundleID: String
    let pid: Int32
    let windowID: UInt32
}
private struct BrowserTarget: Decodable {
    let platform: String
    let application: String
    let bundleID: String
    let windowID: String
    let tabIndex: Int?
}

private struct BrowserTab: Encodable {
    let index: Int
    let title: String
    let url: String
    let active: Bool
}

private struct BrowserWindow: Encodable {
    let window_id: String
    let index: Int
    let revision: String
    let tabs: [BrowserTab]
}

private struct AgentDisplay: Codable {
    let id: UInt32
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

private struct Element: Encodable {
    let path: [Int]
    let role: String
    let label: String
    let frame: [Double]
    let actions: [String]
    let enabled: Bool
    let focused: Bool
    let value: String?
}

private struct WindowInfo: Encodable {
    let window_id: UInt32
    let title: String
    let bounds: Bounds
    let on_screen: Bool
}

private struct Bounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

private struct AppInfo: Encodable {
    let bundle_id: String
    let pid: Int32
    let name: String
    let is_active: Bool
    let is_hidden: Bool
    let windows: [WindowInfo]
}

private struct Request: Decodable {
    let action: String
    let owner: Owner
    let target: Target?
    let controlDirectory: String?
    let ownerPID: Int32?
    let display: Bounds?
    let originalFrame: Bounds?
    let url: String?
    let script: String?
    let bundleID: String?
    let remoteDebugging: Bool?
    let pid: Int32?
    let expectedRevision: String?
    let text: String?
    let newline: Bool?
    let destination: String?
    let element: [Int]?
    let direction: String?
    let key: String?
    let x: Int?
    let y: Int?
    let button: String?
    let count: Int?
    let fromX: Int?
    let fromY: Int?
    let toX: Int?
    let toY: Int?
    let deltaX: Int?
    let deltaY: Int?
    let modifiers: [String]?

    enum Target: Decodable {
        case iterm(ItermTarget)
        case finder(FinderTarget)
        case desktop(DesktopTarget)
        case webbrowser(BrowserTarget)

        private enum CodingKeys: String, CodingKey { case platform, application }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            guard try container.decode(String.self, forKey: .platform) == "macos" else {
                throw HelperError.invalidRequest
            }
            switch try container.decode(String.self, forKey: .application) {
            case "iterm": self = .iterm(try ItermTarget(from: decoder))
            case "finder": self = .finder(try FinderTarget(from: decoder))
            case "desktop": self = .desktop(try DesktopTarget(from: decoder))
            case "webbrowser": self = .webbrowser(try BrowserTarget(from: decoder))
            default: throw HelperError.invalidRequest
            }
        }
    }
}

private struct Response: Encodable {
    let status: String
    let action: String?
    let revision: String?
    let code: String?
    let message: String?
    let outcome: String?
    let elements: [Element]?
    let image: String?
    let width: Int?
    let height: Int?
    let scale: Double?
    let apps: [AppInfo]?
    let pid: Int32?
    let windows: [WindowInfo]?
    let browserWindows: [BrowserWindow]?
    let display: AgentDisplay?
    let originalFrame: Bounds?
    let tabIndex: Int?
    let value: String?
    let truncated: Bool?
    let accessible: Bool?
    let effect: String?
    let exited: Bool?
}

private struct ApplicationTarget {
    let descriptor: NSAppleEventDescriptor
}

private enum HelperError: Error {
    case invalidRequest
    case appNotRunning
    case automationDenied
    case targetNotFound
    case staleRevision
    case targetConflict
    case nativeFailure
    case javascriptEvaluationFailed
    case captureFailed(String)
    case unknownOutcome
    case accessibilityDenied
    case screenRecordingDenied
    case backgroundUnavailable
    case focusRestoreFailed
    case quitPending
    case agentDisplayUnavailable
    case windowNotMovable

    var response: Response {
        switch self {
        case .invalidRequest:
            return failure("invalid_request", "The native request is invalid")
        case .appNotRunning:
            return failure("app_not_running", "The requested application is not running")
        case .automationDenied:
            return failure("automation_denied", "Allow YCoding Computer Use to control the application in System Settings > Privacy & Security > Automation, then retry")
        case .targetNotFound:
            return failure("target_not_found", "The explicitly identified target is unavailable")
        case .staleRevision:
            return failure("stale_revision", "Target state changed; inspect it again before mutation")
        case .targetConflict:
            return failure("target_conflict", "The requested destination already exists")
        case .nativeFailure:
            return failure("native_failure", "The application rejected the native command")
        case .javascriptEvaluationFailed:
            return failure("native_failure", "Browser JavaScript evaluation failed. If JavaScript from Apple Events is disabled in Safari or Chrome, enable that setting; inspect the tab before retrying.", outcome: "unknown")
        case .captureFailed(let reason):
            return failure("native_failure", "Window capture failed: \(reason.prefix(200))")
        case .unknownOutcome:
            return failure("unknown_outcome", "The native command may have been accepted; inspect before any further mutation", outcome: "unknown")
        case .accessibilityDenied:
            return failure("accessibility_denied", "Allow YCoding Computer Use in System Settings > Privacy & Security > Accessibility, then retry")
        case .screenRecordingDenied:
            return failure("screen_recording_denied", "Allow YCoding Computer Use in System Settings > Privacy & Security > Screen Recording, then retry")
        case .backgroundUnavailable:
            return failure("background_unavailable", "Target-only background input is unavailable; use an Accessibility element route")
        case .agentDisplayUnavailable:
            return failure("background_unavailable", "The private agent display could not be created")
        case .windowNotMovable:
            return failure("background_unavailable", "The window exposes no movable Accessibility window; a full-screen window must leave full screen before staging")
        case .focusRestoreFailed:
            return failure("focus_restore_failed", "Original foreground focus could not be restored after background input; inspect before any further mutation", outcome: "unknown")
        case .quitPending:
            return failure("quit_pending", "Application did not exit after a graceful quit request; resolve its prompt before relaunch", outcome: "not_started")
        }
    }
}

private func failure(_ code: String, _ message: String, outcome: String = "not_started") -> Response {
    Response(status: "error", action: nil, revision: nil, code: code, message: message, outcome: outcome, elements: nil, image: nil, width: nil, height: nil, scale: nil, apps: nil, pid: nil, windows: nil, browserWindows: nil, display: nil, originalFrame: nil, tabIndex: nil, value: nil, truncated: nil, accessible: nil, effect: nil, exited: nil)
}

private func success(_ action: String, _ revision: String, elements: [Element]? = nil, image: String? = nil,
                     width: Int? = nil, height: Int? = nil, scale: Double? = nil, apps: [AppInfo]? = nil,
                     pid: Int32? = nil, windows: [WindowInfo]? = nil, browserWindows: [BrowserWindow]? = nil,
                     display: AgentDisplay? = nil, originalFrame: Bounds? = nil,
                     tabIndex: Int? = nil, value: String? = nil, truncated: Bool? = nil,
                     accessible: Bool? = nil, effect: String? = nil, exited: Bool? = nil) -> Response {
    Response(status: "ok", action: action, revision: revision, code: nil, message: nil, outcome: nil,
             elements: elements, image: image, width: width, height: height, scale: scale, apps: apps, pid: pid, windows: windows,
             browserWindows: browserWindows, display: display, originalFrame: originalFrame,
             tabIndex: tabIndex, value: value, truncated: truncated,
             accessible: accessible, effect: effect, exited: exited)
}

private func gracefulQuit(bundleID: String, pid: Int32) throws -> Bool {
    guard pid > 0, let app = NSRunningApplication(processIdentifier: pid),
          app.bundleIdentifier == bundleID, !app.isTerminated else { throw HelperError.appNotRunning }
    guard app.terminate() else { return false }
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
        if app.isTerminated || NSRunningApplication(processIdentifier: pid) == nil { return true }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return app.isTerminated || NSRunningApplication(processIdentifier: pid) == nil
}

private func windowInfos() -> [Int32: [WindowInfo]] {
    let infos = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var byPID: [Int32: [WindowInfo]] = [:]
    for info in infos {
        guard let pid = info[kCGWindowOwnerPID as String] as? Int32,
              let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
              let id = info[kCGWindowNumber as String] as? UInt32,
              let dictionary = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
              rect.width > 0, rect.height > 0, byPID[pid, default: []].count < 32 else { continue }
        byPID[pid, default: []].append(WindowInfo(window_id: id,
            title: String((info[kCGWindowName as String] as? String ?? "").prefix(200)),
            bounds: Bounds(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height),
            on_screen: (info[kCGWindowIsOnscreen as String] as? Bool) == true))
    }
    return byPID
}

private func runningApps() -> [AppInfo] {
    let windows = windowInfos()
    return NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil && !$0.isTerminated }
        .prefix(64).map { app in
            AppInfo(bundle_id: app.bundleIdentifier ?? "", pid: app.processIdentifier,
                    name: String((app.localizedName ?? "").prefix(200)), is_active: app.isActive,
                    is_hidden: app.isHidden, windows: windows[app.processIdentifier] ?? [])
        }
}

private func fourCC(_ value: String) -> UInt32 {
    value.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
}

private func requireRunning(_ bundleID: String) throws -> ApplicationTarget {
    guard let application = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
        throw HelperError.appNotRunning
    }
    return ApplicationTarget(descriptor: NSAppleEventDescriptor(processIdentifier: application.processIdentifier))
}

private func requireAutomation(_ target: ApplicationTarget, eventClass: UInt32, eventID: UInt32) throws {
    // Asking lets macOS list this app under Automation and show its own allow prompt; the call waits for that answer.
    let status = AEDeterminePermissionToAutomateTarget(
        target.descriptor.aeDesc,
        AEEventClass(eventClass),
        AEEventID(eventID),
        true
    )
    guard status == noErr else { throw HelperError.automationDenied }
}

private func objectSpecifier(
    desiredClass: UInt32,
    keyForm: UInt32,
    keyData: NSAppleEventDescriptor,
    container: NSAppleEventDescriptor
) throws -> NSAppleEventDescriptor {
    let record = NSAppleEventDescriptor.record()
    record.setDescriptor(NSAppleEventDescriptor(typeCode: desiredClass), forKeyword: AEKeyword(keyAEDesiredClass))
    record.setDescriptor(NSAppleEventDescriptor(typeCode: keyForm), forKeyword: AEKeyword(keyAEKeyForm))
    record.setDescriptor(keyData, forKeyword: AEKeyword(keyAEKeyData))
    record.setDescriptor(container, forKeyword: AEKeyword(keyAEContainer))
    guard let result = record.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else {
        throw HelperError.nativeFailure
    }
    return result
}

private func property(_ code: UInt32, of object: NSAppleEventDescriptor) throws -> NSAppleEventDescriptor {
    try objectSpecifier(
        desiredClass: UInt32(typeProperty),
        keyForm: UInt32(formPropertyID),
        keyData: NSAppleEventDescriptor(typeCode: code),
        container: object
    )
}

private func send(
    _ target: ApplicationTarget,
    eventClass: UInt32,
    eventID: UInt32,
    directObject: NSAppleEventDescriptor,
    parameters: [(UInt32, NSAppleEventDescriptor)] = []
) throws -> NSAppleEventDescriptor {
    let event = NSAppleEventDescriptor(
        eventClass: AEEventClass(eventClass),
        eventID: AEEventID(eventID),
        targetDescriptor: target.descriptor,
        returnID: AEReturnID(kAutoGenerateReturnID),
        transactionID: AETransactionID(kAnyTransactionID)
    )
    event.setParam(directObject, forKeyword: AEKeyword(keyDirectObject))
    for (key, value) in parameters { event.setParam(value, forKeyword: AEKeyword(key)) }
    do {
        let reply = try event.sendEvent(options: [.waitForReply, .neverInteract, .dontRecord], timeout: 10)
        if let error = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber)), error.int32Value != 0 {
            if error.int32Value == errAENoSuchObject { throw HelperError.targetNotFound }
            throw HelperError.nativeFailure
        }
        return reply
    } catch let error as NSError {
        if error.code == errAENoSuchObject { throw HelperError.targetNotFound }
        throw HelperError.nativeFailure
    }
}

private func get(
    _ target: ApplicationTarget,
    propertyCode: UInt32,
    of object: NSAppleEventDescriptor
) throws -> NSAppleEventDescriptor {
    let reply = try send(
        target,
        eventClass: UInt32(kAECoreSuite),
        eventID: UInt32(kAEGetData),
        directObject: try property(propertyCode, of: object)
    )
    guard let result = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)) else {
        throw HelperError.targetNotFound
    }
    return result
}

private func browserApplication(_ bundleID: String) throws -> (ApplicationTarget, Bool) {
    guard bundleID == "com.apple.Safari" || bundleID == "com.google.Chrome" else { throw HelperError.invalidRequest }
    let application = try requireRunning(bundleID)
    try requireAutomation(application, eventClass: UInt32(kAECoreSuite), eventID: UInt32(kAEGetData))
    return (application, bundleID == "com.apple.Safari")
}

private func browserWindow(_ id: String, safari: Bool) throws -> NSAppleEventDescriptor {
    let key: NSAppleEventDescriptor
    if safari {
        guard let value = Int32(id) else { throw HelperError.invalidRequest }
        key = NSAppleEventDescriptor(int32: value)
    } else {
        key = NSAppleEventDescriptor(string: id)
    }
    return try objectSpecifier(desiredClass: fourCC("cwin"), keyForm: UInt32(formUniqueID), keyData: key, container: NSAppleEventDescriptor.null())
}

private func browserTab(_ window: NSAppleEventDescriptor, index: Int, safari: Bool) throws -> NSAppleEventDescriptor {
    guard index > 0 else { throw HelperError.invalidRequest }
    return try objectSpecifier(desiredClass: fourCC(safari ? "bTab" : "CrTb"), keyForm: UInt32(formAbsolutePosition), keyData: NSAppleEventDescriptor(int32: Int32(index)), container: window)
}

private func browserRoot() throws -> NSAppleEventDescriptor {
    NSAppleEventDescriptor.null()
}

private func browserCount(_ app: ApplicationTarget, code: String) throws -> Int {
    let reply = try send(app, eventClass: UInt32(kAECoreSuite), eventID: fourCC("corecnte"), directObject: try browserRoot(),
                         parameters: [(fourCC("kocl"), NSAppleEventDescriptor(typeCode: fourCC(code)))])
    guard let count = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.int32Value, count >= 0 else { throw HelperError.nativeFailure }
    return Int(count)
}

private func browserSnapshot(_ bundleID: String) throws -> (ApplicationTarget, Bool, [BrowserWindow]) {
    let (app, safari) = try browserApplication(bundleID)
    let windowCount = min(16, try browserCount(app, code: "cwin"))
    if windowCount == 0 { return (app, safari, []) }
    let windows = try (1...windowCount).map { index -> BrowserWindow in
        let window = try objectSpecifier(desiredClass: fourCC("cwin"), keyForm: UInt32(formAbsolutePosition), keyData: NSAppleEventDescriptor(int32: Int32(index)), container: try browserRoot())
        let id = try get(app, propertyCode: fourCC("ID  "), of: window)
        let windowID = safari ? String(id.int32Value) : (id.stringValue ?? "")
        guard !windowID.isEmpty else { throw HelperError.targetNotFound }
        let total = try browserCountForWindow(app, window, safari: safari)
        let count = min(100, total)
        let activeIndex: Int
        if safari {
            let activeTab = try get(app, propertyCode: fourCC("cTab"), of: window)
            activeIndex = Int(try get(app, propertyCode: fourCC("pidx"), of: activeTab).int32Value)
        } else {
            activeIndex = Int(try get(app, propertyCode: fourCC("acTI"), of: window).int32Value)
        }
        let values: [(BrowserTab, [String])]
        if count == 0 { values = [] }
        else {
            values = try (1...count).map { tabIndex -> (BrowserTab, [String]) in
                let tab = try browserTab(window, index: tabIndex, safari: safari)
                let title = try get(app, propertyCode: fourCC("pnam"), of: tab).stringValue ?? ""
                let urlCode = safari ? fourCC("pURL") : fourCC("URL ")
                let url = try get(app, propertyCode: urlCode, of: tab).stringValue ?? ""
                let active = activeIndex == tabIndex
                return (BrowserTab(index: tabIndex, title: boundedUTF8(title, maximum: 200), url: boundedUTF8(url, maximum: 400), active: active), [title, url, active ? "1" : "0"])
            }
        }
        let tabs = values.map(\.0)
        let revision = sha256(values.flatMap(\.1) + [String(activeIndex), String(total)])
        return BrowserWindow(window_id: windowID, index: index, revision: revision, tabs: tabs)
    }
    return (app, safari, windows)
}

private func browserCountForWindow(_ app: ApplicationTarget, _ window: NSAppleEventDescriptor, safari: Bool) throws -> Int {
    let reply = try send(app, eventClass: UInt32(kAECoreSuite), eventID: fourCC("corecnte"), directObject: window,
                         parameters: [(fourCC("kocl"), NSAppleEventDescriptor(typeCode: fourCC(safari ? "bTab" : "CrTb")))])
    guard let count = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.int32Value, count >= 0 else { throw HelperError.nativeFailure }
    return Int(count)
}

private func browserTabs(_ request: Request) throws -> Response {
    guard let bundleID = request.bundleID else { throw HelperError.invalidRequest }
    let (_, _, windows) = try browserSnapshot(bundleID)
    return success(request.action, "", browserWindows: windows)
}

private func isWebURL(_ value: String) -> Bool {
    guard let url = URL(string: value) else { return false }
    return value.range(of: #"^https?://"#, options: .regularExpression.union(.caseInsensitive)) != nil &&
        ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host?.isEmpty == false
}

private func browserMutation(_ request: Request, target: BrowserTarget) throws -> Response {
    guard target.platform == "macos", target.application == "webbrowser",
          let tabIndex = target.tabIndex, tabIndex > 0, tabIndex <= 100,
          let expected = request.expectedRevision else { throw HelperError.invalidRequest }
    let (app, safari, windows) = try browserSnapshot(target.bundleID)
    guard let before = windows.first(where: { $0.window_id == target.windowID }), before.revision == expected else { throw HelperError.staleRevision }
    if request.action == "webbrowser.new_tab", before.tabs.count >= 100 { throw HelperError.invalidRequest }
    let window = try browserWindow(target.windowID, safari: safari)
    let tab = try browserTab(window, index: tabIndex, safari: safari)
    let core = UInt32(kAECoreSuite)
    if request.action == "webbrowser.new_tab", let url = request.url, !isWebURL(url) { throw HelperError.invalidRequest }
    do {
        switch request.action {
        case "webbrowser.navigate":
            guard let url = request.url, isWebURL(url) else { throw HelperError.invalidRequest }
            let code = safari ? fourCC("pURL") : fourCC("URL ")
            _ = try send(app, eventClass: core, eventID: UInt32(kAESetData), directObject: try property(code, of: tab), parameters: [(fourCC("data"), NSAppleEventDescriptor(string: url))])
        case "webbrowser.back", "webbrowser.forward", "webbrowser.reload":
            if safari {
                let source = request.action == "webbrowser.back" ? "history.back()" : request.action == "webbrowser.forward" ? "history.forward()" : "location.reload()"
                _ = try send(app, eventClass: fourCC("sfri"), eventID: fourCC("sfridojs"), directObject: NSAppleEventDescriptor(string: source), parameters: [(fourCC("dcnm"), tab)])
            } else {
                let eventID = request.action == "webbrowser.back" ? fourCC("CrSuBack") : request.action == "webbrowser.forward" ? fourCC("CrSuFwd ") : fourCC("CrSuRlod")
                _ = try send(app, eventClass: fourCC("CrSu"), eventID: eventID, directObject: tab)
            }
        case "webbrowser.new_tab":
            let properties = NSAppleEventDescriptor.record()
            if let url = request.url {
                guard isWebURL(url) else { throw HelperError.invalidRequest }
                properties.setDescriptor(NSAppleEventDescriptor(string: url), forKeyword: AEKeyword(safari ? fourCC("pURL") : fourCC("URL ")))
            }
            _ = try send(app, eventClass: core, eventID: UInt32(kAECreateElement), directObject: NSAppleEventDescriptor.null(), parameters: [(fourCC("kocl"), NSAppleEventDescriptor(typeCode: fourCC(safari ? "bTab" : "CrTb"))), (fourCC("insh"), window), (fourCC("prdt"), properties)])
        case "webbrowser.close_tab":
            _ = try send(app, eventClass: core, eventID: fourCC("coreclos"), directObject: tab)
        case "webbrowser.eval":
            guard let script = request.script, script.utf8.count <= 65_536 else { throw HelperError.invalidRequest }
            let reply = try send(app, eventClass: safari ? fourCC("sfri") : fourCC("CrSu"), eventID: safari ? fourCC("sfridojs") : fourCC("CrSuExJa"), directObject: safari ? NSAppleEventDescriptor(string: script) : tab, parameters: [(safari ? fourCC("dcnm") : fourCC("JvSc"), safari ? tab : NSAppleEventDescriptor(string: script))])
            let valueDescriptor = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))
            let raw = valueDescriptor?.stringValue ?? valueDescriptor?.description ?? ""
            let value = boundedUTF8(raw, maximum: 16_384)
            return success(request.action, settledBrowserWindow(target)?.revision ?? before.revision, value: value, truncated: raw.utf8.count > 16_384)
        default: throw HelperError.invalidRequest
        }
    } catch let error as HelperError {
        if case .nativeFailure = error,
           (request.action == "webbrowser.eval" || (safari && ["webbrowser.back", "webbrowser.forward", "webbrowser.reload"].contains(request.action))) {
            throw HelperError.javascriptEvaluationFailed
        }
        if case .nativeFailure = error { throw HelperError.unknownOutcome }
        throw error
    }
    catch { throw HelperError.unknownOutcome }
    guard let settled = settledBrowserWindow(target) else { throw HelperError.unknownOutcome }
    return success(request.action, settled.revision, tabIndex: request.action == "webbrowser.new_tab" ? settled.tabs.count : nil)
}

private func settledBrowserWindow(_ target: BrowserTarget) -> BrowserWindow? {
    var previous: BrowserWindow?
    for _ in 0..<14 {
        Thread.sleep(forTimeInterval: 0.15)
        guard let current = try? browserSnapshot(target.bundleID).2.first(where: { $0.window_id == target.windowID }) else { return nil }
        if current.revision == previous?.revision { return current }
        previous = current
    }
    return previous
}

private func itermTarget(_ target: ItermTarget) throws -> (window: NSAppleEventDescriptor, session: NSAppleEventDescriptor) {
    let window = try objectSpecifier(
        desiredClass: fourCC("cwin"),
        keyForm: UInt32(formUniqueID),
        keyData: NSAppleEventDescriptor(int32: target.windowID),
        container: NSAppleEventDescriptor.null()
    )
    let tab = try objectSpecifier(
        desiredClass: fourCC("Trmt"),
        keyForm: UInt32(formAbsolutePosition),
        keyData: NSAppleEventDescriptor(int32: target.tabIndex),
        container: window
    )
    let session = try objectSpecifier(
        desiredClass: fourCC("Trms"),
        keyForm: UInt32(formUniqueID),
        keyData: NSAppleEventDescriptor(string: target.sessionID),
        container: tab
    )
    return (window, session)
}

private func sha256(_ values: [String]) -> String {
    SHA256.hash(data: Data(values.joined(separator: "\u{0}").utf8))
        .map { String(format: "%02x", $0) }
        .joined()
}

private func boundedUTF8(_ value: String, maximum: Int) -> String {
    var bytes = Array(value.utf8.prefix(maximum))
    while String(bytes: bytes, encoding: .utf8) == nil { bytes.removeLast() }
    return String(bytes: bytes, encoding: .utf8) ?? ""
}

private func inspectIterm(_ input: ItermTarget) throws -> (ApplicationTarget, String) {
    guard input.windowID > 0, input.tabIndex > 0, !input.sessionID.isEmpty else { throw HelperError.invalidRequest }
    let application = try requireRunning("com.googlecode.iterm2")
    try requireAutomation(application, eventClass: UInt32(kAECoreSuite), eventID: UInt32(kAEGetData))
    let target = try itermTarget(input)
    let windowID = try get(application, propertyCode: fourCC("ID  "), of: target.window).int32Value
    let sessionID = try get(application, propertyCode: fourCC("Uniq"), of: target.session).stringValue
    let contents = try get(application, propertyCode: fourCC("Cntt"), of: target.session).stringValue
    let shellPrompt = try get(application, propertyCode: fourCC("Iaps"), of: target.session).booleanValue
    guard windowID == input.windowID, sessionID == input.sessionID, let contents else { throw HelperError.targetNotFound }
    return (application, sha256([String(windowID), String(input.tabIndex), input.sessionID, contents, String(shellPrompt)]))
}

private func finderRevision(_ input: FinderTarget) throws -> (ApplicationTarget, String) {
    guard input.platform == "macos", input.application == "finder", input.path.hasPrefix("/") else {
        throw HelperError.invalidRequest
    }
    let application = try requireRunning("com.apple.finder")
    try requireAutomation(application, eventClass: UInt32(kAECoreSuite), eventID: UInt32(kAEGetData))
    let url = URL(fileURLWithPath: input.path).standardizedFileURL
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else {
        throw HelperError.targetNotFound
    }
    guard let size = attributes[.size] as? NSNumber,
          let modified = attributes[.modificationDate] as? Date,
          let identifier = attributes[.systemFileNumber] as? NSNumber else { throw HelperError.targetNotFound }
    return (application, sha256([url.path, size.stringValue, String(modified.timeIntervalSince1970), identifier.stringValue]))
}

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    (attribute(element, name) as? String ?? "").prefix(256).description
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(64).map { $0 }
}

private func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool {
    (attribute(element, name) as? NSNumber)?.boolValue ?? false
}

private func imageScale(_ bounds: CGRect) -> Double {
    min(1, 1280 / max(bounds.width, bounds.height))
}

private func elementFrame(_ element: AXUIElement, in bounds: CGRect) -> [Double]? {
    guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &origin),
          AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions) else { return nil }
    let scale = imageScale(bounds)
    return [(origin.x - bounds.minX) * scale, (origin.y - bounds.minY) * scale,
            dimensions.width * scale, dimensions.height * scale]
}

private let advertisedActions: [(String, String)] = [
    (kAXPressAction, "press"), (kAXConfirmAction, "confirm"), (kAXIncrementAction, "increment"),
    (kAXDecrementAction, "decrement"), (kAXShowMenuAction, "show_menu")
]

private func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return names as? [String] ?? []
}

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ windowID: inout CGWindowID) -> AXError

@_silgen_name("_AXUIElementCreateWithRemoteToken")
private func _AXUIElementCreateWithRemoteToken(_ token: CFData) -> Unmanaged<AXUIElement>?

private func windowID(_ element: AXUIElement) -> CGWindowID? {
    var windowID = CGWindowID(0)
    guard _AXUIElementGetWindow(element, &windowID) == .success else { return nil }
    return windowID
}

// kAXWindowsAttribute omits windows on other Spaces; enumerate the app's remote element tokens instead.
private func offSpaceWindows(_ target: DesktopTarget) -> [AXUIElement] {
    var token = Data(count: 20)
    token.withUnsafeMutableBytes { bytes in
        bytes.storeBytes(of: target.pid, toByteOffset: 0, as: Int32.self)
        bytes.storeBytes(of: Int32(0), toByteOffset: 4, as: Int32.self)
        bytes.storeBytes(of: UInt32(0x636f_636f), toByteOffset: 8, as: UInt32.self)
    }
    let deadline = Date().addingTimeInterval(1)
    var windows: [AXUIElement] = []
    for elementID in UInt64(0)..<2000 {
        guard Date() < deadline else { return [] }
        token.withUnsafeMutableBytes { $0.storeBytes(of: elementID, toByteOffset: 12, as: UInt64.self) }
        guard let element = _AXUIElementCreateWithRemoteToken(token as CFData)?.takeRetainedValue() else { continue }
        AXUIElementSetMessagingTimeout(element, 0.1)
        guard windowID(element) == target.windowID, stringAttribute(element, kAXRoleAttribute) == kAXWindowRole else { continue }
        windows.append(element)
    }
    return windows
}

private struct DesktopWindow {
    let element: AXUIElement?
    let bounds: CGRect
    let title: String
}

private func desktopWindow(_ target: DesktopTarget) throws -> DesktopWindow {
    guard target.platform == "macos", target.application == "desktop", !target.bundleID.isEmpty,
          target.pid > 0, target.windowID > 0,
          let app = NSRunningApplication(processIdentifier: target.pid),
          app.bundleIdentifier == target.bundleID, !app.isTerminated else { throw HelperError.appNotRunning }
    guard let windows = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(target.windowID)) as? [[String: Any]],
          windows.count == 1, let info = windows.first,
          (info[kCGWindowOwnerPID as String] as? Int) == Int(target.pid),
          (info[kCGWindowLayer as String] as? Int) == 0,
          let dictionary = info[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary), bounds.width > 0, bounds.height > 0 else {
        throw HelperError.targetNotFound
    }
    // Requesting trust lets macOS list this app under Accessibility and show its own allow prompt.
    guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) else {
        throw HelperError.accessibilityDenied
    }
    let application = AXUIElementCreateApplication(target.pid)
    AXUIElementSetMessagingTimeout(application, 5)
    enableElectronAccessibility(application)
    let listed = (attribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter { windowID($0) == target.windowID }
    let onscreen = (info[kCGWindowIsOnscreen as String] as? Bool) == true
    let matches = listed.isEmpty && !onscreen ? offSpaceWindows(target) : listed
    guard matches.count <= 1 else { throw HelperError.targetNotFound }
    if let match = matches.first { AXUIElementSetMessagingTimeout(match, 5) }
    return DesktopWindow(element: matches.first, bounds: bounds, title: String((info[kCGWindowName as String] as? String ?? "").prefix(200)))
}

// Electron builds its web-content Accessibility tree only after a client sets AXManualAccessibility. Its getter
// always reads false, so the idempotent set is repeated; the tree builds asynchronously for later inspects.
private func enableElectronAccessibility(_ application: AXUIElement) {
    let name = "AXManualAccessibility" as CFString
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(application, name, &settable) == .success, settable.boolValue else { return }
    AXUIElementSetAttributeValue(application, name, kCFBooleanTrue)
}

private func desktopSnapshot(_ target: DesktopTarget) throws -> (DesktopWindow, String, [Element]) {
    let window = try desktopWindow(target)
    var entries: [Element] = []
    var revisionParts = [target.bundleID, String(target.pid), String(target.windowID), NSStringFromRect(window.bounds), window.title]
    guard let root = window.element else { return (window, sha256(revisionParts), []) }
    var queue: [(AXUIElement, [Int])] = [(root, [])]
    var cursor = 0
    while cursor < queue.count && entries.count < 400 {
        let (node, path) = queue[cursor]
        cursor += 1
        let role = stringAttribute(node, kAXRoleAttribute)
        let label = stringAttribute(node, kAXTitleAttribute).isEmpty ? stringAttribute(node, kAXDescriptionAttribute) : stringAttribute(node, kAXTitleAttribute)
        let secure = role == "AXSecureTextField" || role.localizedCaseInsensitiveContains("secure")
        let rawValue = secure ? nil : attribute(node, kAXValueAttribute)
        let value = (rawValue as? String ?? (rawValue as? NSNumber)?.stringValue).map { String($0.prefix(200)) }
        let frame = elementFrame(node, in: window.bounds)
        let actions = actionNames(node)
        let enabled = boolAttribute(node, kAXEnabledAttribute)
        let focused = boolAttribute(node, kAXFocusedAttribute)
        entries.append(Element(path: path, role: role, label: label, frame: frame ?? [0, 0, 0, 0],
                               actions: advertisedActions.compactMap { actions.contains($0.0) ? $0.1 : nil },
                               enabled: enabled, focused: focused, value: value))
        revisionParts.append("\(path):\(role):\(label):\(value ?? ""):\(enabled):\(focused):\(frame ?? []):\(actions)")
        if path.count < 12 {
            queue.append(contentsOf: children(node).enumerated().map { ($0.element, path + [$0.offset]) })
        }
    }
    return (window, sha256(revisionParts), entries)
}

private func desktopElement(_ window: AXUIElement, path: [Int]) throws -> AXUIElement {
    guard path.count <= 12, path.allSatisfy({ $0 >= 0 && $0 < 64 }) else { throw HelperError.invalidRequest }
    return try path.reduce(window) { parent, index in
        let nodes = children(parent)
        guard index < nodes.count else { throw HelperError.targetNotFound }
        return nodes[index]
    }
}

// A hash of a small window image; nil when Screen Recording or capture is unavailable.
private func windowFingerprint(_ target: DesktopTarget) async -> String? {
    guard #available(macOS 14, *), CGPreflightScreenCaptureAccess(),
          let source = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false).windows
            .first(where: { $0.windowID == target.windowID && $0.owningApplication?.processID == target.pid }) else { return nil }
    let configuration = SCStreamConfiguration()
    let scale = min(1, 240 / max(1, source.frame.width, source.frame.height))
    configuration.width = max(1, Int(source.frame.width * scale))
    configuration.height = max(1, Int(source.frame.height * scale))
    configuration.showsCursor = false
    guard let image = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: source),
                                                                   configuration: configuration),
          let pixels = image.dataProvider?.data as Data? else { return nil }
    return SHA256.hash(data: pixels).map { String(format: "%02x", $0) }.joined()
}

private func captureWindow(_ target: DesktopTarget) async throws -> (String, Int, Int, Double) {
    guard #available(macOS 14, *) else { throw HelperError.nativeFailure }
    guard CGRequestScreenCaptureAccess() else { throw HelperError.screenRecordingDenied }
    let targetWindow = try desktopWindow(target)
    let windows: [SCWindow]
    do { windows = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false).windows }
    catch { throw HelperError.nativeFailure }
    guard let source = windows.first(where: { $0.windowID == target.windowID && $0.owningApplication?.processID == target.pid && $0.owningApplication?.bundleIdentifier == target.bundleID }) else { throw HelperError.targetNotFound }
    let filter = SCContentFilter(desktopIndependentWindow: source)
    let configuration = SCStreamConfiguration()
    let scale = imageScale(targetWindow.bounds)
    configuration.width = max(1, Int(targetWindow.bounds.width * scale))
    configuration.height = max(1, Int(targetWindow.bounds.height * scale))
    configuration.showsCursor = false
    let image: CGImage
    do { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) }
    catch { throw HelperError.captureFailed(error.localizedDescription) }
    _ = try desktopWindow(target)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let jpeg = [0.6, 0.45, 0.3, 0.2].lazy
        .compactMap({ bitmap.representation(using: .jpeg, properties: [.compressionFactor: $0]) })
        .first(where: { $0.count <= 600_000 }) else { throw HelperError.captureFailed("image exceeds 600 KB at the lowest quality") }
    return (jpeg.base64EncodedString(), image.width, image.height, scale)
}

private func settledRevision(_ snapshot: () throws -> String) throws -> String {
    let deadline = Date().addingTimeInterval(0.75)
    var previous = try snapshot()
    repeat {
        Thread.sleep(forTimeInterval: 0.05)
        let current = try snapshot()
        if current == previous { return current }
        previous = current
    } while Date() < deadline
    return previous
}

private func axFrame(_ element: AXUIElement) throws -> CGRect {
    guard let rawPosition = attribute(element, kAXPositionAttribute), CFGetTypeID(rawPosition) == AXValueGetTypeID(),
          let rawSize = attribute(element, kAXSizeAttribute), CFGetTypeID(rawSize) == AXValueGetTypeID() else { throw HelperError.windowNotMovable }
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(rawPosition, to: AXValue.self), .cgPoint, &origin),
          AXValueGetValue(unsafeBitCast(rawSize, to: AXValue.self), .cgSize, &size),
          size.width > 0, size.height > 0 else { throw HelperError.windowNotMovable }
    return CGRect(origin: origin, size: size)
}

private func requireSettable(_ element: AXUIElement, _ name: String) throws {
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success, settable.boolValue else {
        throw HelperError.windowNotMovable
    }
}

private func setWindowPosition(_ element: AXUIElement, _ origin: CGPoint) throws {
    var value = origin
    guard let attributeValue = AXValueCreate(.cgPoint, &value),
          AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, attributeValue) == .success else { throw HelperError.unknownOutcome }
}

private func setWindowSize(_ element: AXUIElement, _ size: CGSize) throws {
    var value = size
    guard let attributeValue = AXValueCreate(.cgSize, &value),
          AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, attributeValue) == .success else { throw HelperError.unknownOutcome }
}

private func stageDesktop(_ request: Request, target: DesktopTarget) throws -> Response {
    guard let expected = request.expectedRevision, let display = request.display,
          display.width > 0, display.height > 0 else { throw HelperError.invalidRequest }
    let displayBounds = CGRect(x: display.x, y: display.y, width: display.width, height: display.height)
    guard displayBounds.width > 0, displayBounds.height > 0 else { throw HelperError.agentDisplayUnavailable }
    let (window, revision, _) = try desktopSnapshot(target)
    guard revision == expected else { throw HelperError.staleRevision }
    guard let element = window.element else { throw HelperError.windowNotMovable }
    let original = try axFrame(element)
    try requireSettable(element, kAXPositionAttribute)
    try requireSettable(element, kAXSizeAttribute)
    let margin = 16.0
    let origin = CGPoint(x: displayBounds.minX + margin, y: displayBounds.minY + margin)
    let size = CGSize(
        width: min(original.width, max(1, displayBounds.width - margin * 2)),
        height: min(original.height, max(1, displayBounds.height - margin * 2)),
    )
    try setWindowPosition(element, origin)
    try setWindowSize(element, size)
    let settledPosition = try axFrame(element).origin
    if abs(settledPosition.x - origin.x) > 1 || abs(settledPosition.y - origin.y) > 1 {
        try setWindowPosition(element, origin)
    }
    let settled: String
    do { settled = try settledRevision { try desktopSnapshot(target).1 } }
    catch { throw HelperError.unknownOutcome }
    return success(request.action, settled, originalFrame: Bounds(x: original.minX, y: original.minY, width: original.width, height: original.height))
}

private func unstageDesktop(_ request: Request, target: DesktopTarget) throws -> Response {
    guard let original = request.originalFrame, original.width > 0, original.height > 0 else { throw HelperError.invalidRequest }
    let window: DesktopWindow
    do { window = try desktopWindow(target) }
    catch { throw HelperError.targetNotFound }
    guard let element = window.element else { throw HelperError.targetNotFound }
    try requireSettable(element, kAXPositionAttribute)
    try requireSettable(element, kAXSizeAttribute)
    let origin = CGPoint(x: original.x, y: original.y)
    try setWindowPosition(element, origin)
    try setWindowSize(element, CGSize(width: original.width, height: original.height))
    let restoredPosition = try axFrame(element).origin
    if abs(restoredPosition.x - origin.x) > 1 || abs(restoredPosition.y - origin.y) > 1 {
        try setWindowPosition(element, origin)
    }
    let settled: String
    do { settled = try settledRevision { try desktopSnapshot(target).1 } }
    catch { throw HelperError.unknownOutcome }
    return success(request.action, settled)
}

// Target-only posting and window stamping follow trycua/cua (MIT), libs/cua-driver/rust/crates/platform-macos/src/input/{skylight,mouse}.rs.
// An unavailable private route fails closed; never send a global HID event or warp the cursor.
private enum BackgroundPost {
    typealias Post = @convention(c) (Int32, CGEvent) -> Void
    typealias SetLocation = @convention(c) (CGEvent, CGPoint) -> Void
    typealias SetField = @convention(c) (CGEvent, UInt32, Int64) -> Void
    static let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    static let post: Post? = library.flatMap { dlsym($0, "SLEventPostToPid") }.map { unsafeBitCast($0, to: Post.self) }
    static let setLocation: SetLocation? = library.flatMap { dlsym($0, "CGEventSetWindowLocation") }.map { unsafeBitCast($0, to: SetLocation.self) }
    static let setField: SetField? = library.flatMap { dlsym($0, "SLEventSetIntegerValueField") }.map { unsafeBitCast($0, to: SetField.self) }
    // Click-group IDs must stay small (sub-second nanoseconds, as in Cua Driver); a microsecond epoch timestamp
    // makes WindowServer drop the grouped pointer events without an error.
    static let groupID = Int64(Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 1) * 1_000_000_000)

    static func send(_ event: CGEvent, target: DesktopTarget, at point: CGPoint?) throws {
        guard let post, let setLocation, let setField else { throw HelperError.backgroundUnavailable }
        setField(event, 40, Int64(target.pid))
        for field: UInt32 in [51, 91, 92] { setField(event, field, Int64(target.windowID)) }
        setField(event, 58, groupID)
        if let point { setLocation(event, point) }
        post(target.pid, event)
    }
}

// Cua Driver (MIT), libs/cua-driver/rust/crates/platform-macos/src/input/skylight.rs:
// Carbon focus records change AppKit's key-window routing without SLPSSetFrontProcess or window ordering.
private struct BackgroundFocus {
    typealias PostRecord = @convention(c) (UnsafeRawPointer?, UnsafePointer<UInt8>?) -> Int32
    typealias GetFront = @convention(c) (UnsafeMutableRawPointer?) -> Int32
    typealias GetPSN = @convention(c) (Int32, UnsafeMutableRawPointer?) -> Int32

    static let postRecord: PostRecord? = BackgroundPost.library.flatMap { dlsym($0, "SLPSPostEventRecordTo") }.map { unsafeBitCast($0, to: PostRecord.self) }
    static let getFront: GetFront? = BackgroundPost.library.flatMap { dlsym($0, "_SLPSGetFrontProcess") }.map { unsafeBitCast($0, to: GetFront.self) }
    static let applicationServices = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY | RTLD_GLOBAL)
    static let getPSN: GetPSN? = applicationServices.flatMap { dlsym($0, "GetProcessForPID") }.map { unsafeBitCast($0, to: GetPSN.self) }

    let previousPSN: [UInt8]
    let previousPID: Int32
    let previousWindow: UInt32
    let targetPSN: [UInt8]
    let targetWindow: UInt32
    let shifted: Bool

    static func begin(_ target: DesktopTarget) throws -> BackgroundFocus {
        guard let previous = NSWorkspace.shared.frontmostApplication?.processIdentifier,
              let previousWindow = keyWindow(previous), let getFront, let getPSN, postRecord != nil else {
            throw HelperError.backgroundUnavailable
        }
        var frontPSN = [UInt8](repeating: 0, count: 8)
        var previousPSN = frontPSN
        var targetPSN = frontPSN
        guard frontPSN.withUnsafeMutableBytes({ getFront($0.baseAddress) }) == 0,
              previousPSN.withUnsafeMutableBytes({ getPSN(previous, $0.baseAddress) }) == 0,
              targetPSN.withUnsafeMutableBytes({ getPSN(target.pid, $0.baseAddress) }) == 0,
              frontPSN == previousPSN else { throw HelperError.backgroundUnavailable }
        let focus = BackgroundFocus(previousPSN: previousPSN, previousPID: previous, previousWindow: previousWindow,
                                    targetPSN: targetPSN, targetWindow: target.windowID,
                                    shifted: previous != target.pid || previousWindow != target.windowID)
        if !focus.shifted { return focus }
        guard focus.post(previousPSN, window: previousWindow, focused: false) else {
            if !focus.restore() { throw HelperError.focusRestoreFailed }
            throw HelperError.backgroundUnavailable
        }
        guard focus.post(targetPSN, window: target.windowID, focused: true) else {
            if !focus.restore() { throw HelperError.focusRestoreFailed }
            throw HelperError.backgroundUnavailable
        }
        Thread.sleep(forTimeInterval: 0.04)
        return focus
    }

    func restore() -> Bool {
        if shifted {
            let defocused = post(targetPSN, window: targetWindow, focused: false)
            let focused = post(previousPSN, window: previousWindow, focused: true)
            if !defocused || !focused { return false }
        }
        guard let getFront = Self.getFront else { return false }
        var frontPSN = [UInt8](repeating: 0, count: 8)
        return frontPSN.withUnsafeMutableBytes { getFront($0.baseAddress) } == 0 && frontPSN == previousPSN &&
            NSWorkspace.shared.frontmostApplication?.processIdentifier == previousPID
    }

    private func post(_ psn: [UInt8], window: UInt32, focused: Bool) -> Bool {
        guard let postRecord = Self.postRecord else { return false }
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        for index in 0..<4 { record[0x3C + index] = UInt8(truncatingIfNeeded: window >> (index * 8)) }
        record[0x8A] = focused ? 0x01 : 0x02
        return psn.withUnsafeBytes { bytes in
            record.withUnsafeBufferPointer { postRecord(bytes.baseAddress, $0.baseAddress) }
        } == 0
    }

    private static func keyWindow(_ pid: Int32) -> UInt32? {
        let app = AXUIElementCreateApplication(pid)
        if let focused = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(),
           let id = windowID(unsafeBitCast(focused, to: AXUIElement.self)) { return id }
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 })?[kCGWindowNumber as String] as? UInt32
    }
}

private func withBackgroundFocus(_ target: DesktopTarget, _ body: () throws -> Void) throws {
    let focus = try BackgroundFocus.begin(target)
    var restored = false
    var actionError: Error?
    do {
        defer { restored = focus.restore() }
        do { try body() }
        catch { actionError = error }
        if focus.shifted { Thread.sleep(forTimeInterval: 0.05) }
    }
    guard restored else { throw HelperError.focusRestoreFailed }
    if let actionError { throw actionError }
}

private func windowPoint(_ x: Int, _ y: Int, bounds: CGRect) throws -> CGPoint {
    let scale = imageScale(bounds)
    let local = CGPoint(x: Double(x) / scale, y: Double(y) / scale)
    guard x >= 0, y >= 0, local.x < bounds.width, local.y < bounds.height else { throw HelperError.invalidRequest }
    return CGPoint(x: bounds.minX + local.x, y: bounds.minY + local.y)
}

// Field stamps follow Cua Driver's background click route (MIT), input/mouse.rs `click_at_xy_chromium`:
// f0 gesture phase, f1 click state, f3 button number, f7 touch subtype, f40 pid filter, f51/f91/f92 window routing,
// f58 click group, and a screen-space window location, created from the HID system event source.
private func pointerEvent(_ type: CGEventType, _ button: CGMouseButton, _ point: CGPoint,
                          _ target: DesktopTarget, click: Int = 1, phase: Int64? = nil) throws {
    guard let post = BackgroundPost.post, let setLocation = BackgroundPost.setLocation, let setField = BackgroundPost.setField,
          let source = CGEventSource(stateID: .hidSystemState),
          let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw HelperError.backgroundUnavailable
    }
    let window = Int64(target.windowID)
    let fields: [(UInt32, Int64)] = [(0, phase ?? (type == .mouseMoved ? 2 : 3)), (1, Int64(click)), (3, Int64(button.rawValue)),
                                     (7, 3), (40, Int64(target.pid)), (51, window), (58, BackgroundPost.groupID),
                                     (91, window), (92, window)]
    for (field, value) in fields { setField(event, field, value) }
    setLocation(event, point)
    post(target.pid, event)
}

private func coordinateClick(_ request: Request, _ target: DesktopTarget, _ window: DesktopWindow) throws {
    guard let x = request.x, let y = request.y,
          request.button == nil || request.button == "left" || request.button == "right",
          request.count == nil || request.count == 1 || request.count == 2 else { throw HelperError.invalidRequest }
    let point = try windowPoint(x, y, bounds: window.bounds)
    guard BackgroundPost.post != nil, BackgroundPost.setLocation != nil, BackgroundPost.setField != nil else { throw HelperError.backgroundUnavailable }
    let right = request.button == "right"
    let button: CGMouseButton = right ? .right : .left
    try withBackgroundFocus(target) {
        try pointerEvent(.mouseMoved, button, point, target, click: 0, phase: 2)
        Thread.sleep(forTimeInterval: 0.015)
        do {
            if !right {
                // An off-screen press satisfies Chromium's user-activation gate without hitting page content.
                let offscreen = CGPoint(x: -1, y: -1)
                try pointerEvent(.leftMouseDown, .left, offscreen, target, click: 1, phase: 1)
                Thread.sleep(forTimeInterval: 0.001)
                try pointerEvent(.leftMouseUp, .left, offscreen, target, click: 1, phase: 2)
                Thread.sleep(forTimeInterval: 0.1)
            }
            let clicks = request.count ?? 1
            for count in 1...clicks {
                try pointerEvent(right ? .rightMouseDown : .leftMouseDown, button, point, target, click: count)
                Thread.sleep(forTimeInterval: right ? 0.028 : 0.001)
                try pointerEvent(right ? .rightMouseUp : .leftMouseUp, button, point, target, click: count)
                if count < clicks { Thread.sleep(forTimeInterval: 0.08) }
            }
        } catch { throw HelperError.unknownOutcome }
    }
}

private func coordinateDrag(_ request: Request, _ target: DesktopTarget, _ window: DesktopWindow) throws {
    guard let fromX = request.fromX, let fromY = request.fromY, let toX = request.toX, let toY = request.toY else { throw HelperError.invalidRequest }
    let start = try windowPoint(fromX, fromY, bounds: window.bounds)
    let end = try windowPoint(toX, toY, bounds: window.bounds)
    guard BackgroundPost.post != nil, BackgroundPost.setLocation != nil, BackgroundPost.setField != nil else { throw HelperError.backgroundUnavailable }
    try withBackgroundFocus(target) {
        try pointerEvent(.leftMouseDown, .left, start, target)
        do {
            for step in 1...5 {
                let fraction = Double(step) / 5
                let point = CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
                try pointerEvent(.leftMouseDragged, .left, point, target)
                Thread.sleep(forTimeInterval: 0.02)
            }
            try pointerEvent(.leftMouseUp, .left, end, target)
        } catch { throw HelperError.unknownOutcome }
    }
}

private func coordinateScroll(_ request: Request, _ target: DesktopTarget, _ window: DesktopWindow) throws {
    guard let x = request.x, let y = request.y, let deltaX = request.deltaX, let deltaY = request.deltaY,
          let vertical = Int32(exactly: deltaY), let horizontal = Int32(exactly: deltaX) else { throw HelperError.invalidRequest }
    let point = try windowPoint(x, y, bounds: window.bounds)
    guard BackgroundPost.post != nil, BackgroundPost.setLocation != nil, BackgroundPost.setField != nil,
          let source = CGEventSource(stateID: .combinedSessionState),
          let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                              wheel1: vertical, wheel2: horizontal, wheel3: 0) else { throw HelperError.backgroundUnavailable }
    event.location = point
    try withBackgroundFocus(target) { try BackgroundPost.send(event, target: target, at: point) }
}

private func keyboard(_ request: Request, _ target: DesktopTarget) throws {
    guard let source = CGEventSource(stateID: .combinedSessionState) else { throw HelperError.backgroundUnavailable }
    if request.action == "desktop.type" {
        guard let text = request.text, text.utf8.count <= 4096 else { throw HelperError.invalidRequest }
        try withBackgroundFocus(target) {
            var dispatched = false
            // One key event per character: many apps read only the first character of a multi-character event.
            for character in text {
                let chunk = Array(String(character).utf16)
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                    throw dispatched ? HelperError.unknownOutcome : HelperError.backgroundUnavailable
                }
                down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                down.postToPid(target.pid)
                dispatched = true
                up.postToPid(target.pid)
            }
        }
        return
    }
    guard let key = request.key else { throw HelperError.invalidRequest }
    let codes: [String: CGKeyCode] = ["enter": 36, "return": 36, "tab": 48, "escape": 53, "space": 49,
        "delete": 51, "forward_delete": 117, "up": 126, "down": 125, "left": 123, "right": 124,
        "home": 115, "end": 119, "page_up": 116, "page_down": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111]
    let printable = key.unicodeScalars.count == 1 && key.unicodeScalars.allSatisfy { $0.value >= 32 && $0.value != 127 }
    let characterCodes: [Character: CGKeyCode] = ["a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3,
        "g": 5, "h": 4, "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
        "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        "-": 27, "=": 24, "[": 33, "]": 30, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "`": 50]
    let hasModifiers = !(request.modifiers ?? []).isEmpty
    let characterCode = key.lowercased().first.flatMap { characterCodes[$0] }
    guard let code = codes[key] ?? (printable ? (hasModifiers ? characterCode : 0) : nil),
          let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { throw HelperError.invalidRequest }
    var flags: CGEventFlags = []
    for modifier in request.modifiers ?? [] {
        switch modifier {
        case "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option": flags.insert(.maskAlternate)
        case "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: throw HelperError.invalidRequest
        }
    }
    down.flags = flags
    up.flags = flags
    if printable && !hasModifiers {
        let units = Array(key.utf16)
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    }
    try withBackgroundFocus(target) {
        down.postToPid(target.pid)
        up.postToPid(target.pid)
    }
}

private func handle(_ request: Request) async throws -> Response {
    guard !request.owner.sessionID.isEmpty, !request.owner.callID.isEmpty else { throw HelperError.invalidRequest }
    switch (request.action, request.target) {
    case ("webbrowser.tabs", nil):
        return try browserTabs(request)
    case ("webbrowser.navigate", .webbrowser(let target)),
         ("webbrowser.back", .webbrowser(let target)),
         ("webbrowser.forward", .webbrowser(let target)),
         ("webbrowser.reload", .webbrowser(let target)),
         ("webbrowser.new_tab", .webbrowser(let target)),
         ("webbrowser.close_tab", .webbrowser(let target)),
         ("webbrowser.eval", .webbrowser(let target)):
        return try browserMutation(request, target: target)
    case ("desktop.list", nil):
        return success(request.action, "", apps: runningApps())
    case ("desktop.launch", nil):
        guard let bundleID = request.bundleID, !bundleID.isEmpty else { throw HelperError.invalidRequest }
        if request.remoteDebugging == true {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID),
                  FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Frameworks/Electron Framework.framework/Electron Framework").path) else {
                throw HelperError.backgroundUnavailable
            }
            if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first,
               !running.isTerminated, !((try? gracefulQuit(bundleID: bundleID, pid: running.processIdentifier)) ?? false) {
                throw HelperError.quitPending
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            configuration.addsToRecentItems = false
            configuration.arguments = ["--remote-debugging-port=0"]
            do {
                let launched = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
                guard launched.bundleIdentifier == bundleID else { throw HelperError.unknownOutcome }
                return success(request.action, "", pid: launched.processIdentifier, windows: windowInfos()[launched.processIdentifier] ?? [])
            } catch { throw HelperError.unknownOutcome }
        }
        let app: NSRunningApplication
        if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first { app = running }
        else {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { throw HelperError.targetNotFound }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            configuration.addsToRecentItems = false
            do { app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration) }
            catch { throw HelperError.unknownOutcome }
        }
        guard app.bundleIdentifier == bundleID else { throw HelperError.unknownOutcome }
        return success(request.action, "", pid: app.processIdentifier, windows: windowInfos()[app.processIdentifier] ?? [])
    case ("desktop.quit", nil):
        guard let bundleID = request.bundleID, !bundleID.isEmpty, let pid = request.pid else { throw HelperError.invalidRequest }
        return success(request.action, "", exited: try gracefulQuit(bundleID: bundleID, pid: pid))
    case ("desktop.stage", .desktop(let target)):
        return try stageDesktop(request, target: target)
    case ("desktop.unstage", .desktop(let target)):
        do { return try unstageDesktop(request, target: target) }
        catch let error as HelperError {
            if case .appNotRunning = error { throw HelperError.targetNotFound }
            throw error
        }
    case ("desktop.inspect", .desktop(let target)):
        let (window, revision, elements) = try desktopSnapshot(target)
        return success(request.action, revision, elements: elements, accessible: window.element != nil)
    case ("desktop.capture", .desktop(let target)):
        _ = try desktopSnapshot(target)
        let (image, width, height, scale) = try await captureWindow(target)
        return success(request.action, try desktopSnapshot(target).1, image: image, width: width, height: height, scale: scale)
    case ("desktop.click", .desktop(let target)),
         ("desktop.drag", .desktop(let target)),
         ("desktop.type", .desktop(let target)),
         ("desktop.scroll", .desktop(let target)),
         ("desktop.key", .desktop(let target)):
        guard let expected = request.expectedRevision else { throw HelperError.invalidRequest }
        let (window, revision, _) = try desktopSnapshot(target)
        guard revision == expected else { throw HelperError.staleRevision }
        let imageBefore = await windowFingerprint(target)
        if let path = request.element, request.action != "desktop.drag" {
            guard let root = window.element else { throw HelperError.targetNotFound }
            let element = try desktopElement(root, path: path)
            switch request.action {
            case "desktop.click", "desktop.key":
                let axAction = request.action == "desktop.click" ? kAXPressAction : kAXConfirmAction
                guard request.action != "desktop.key" || (request.key == "enter" && (request.modifiers ?? []).isEmpty) else {
                    try keyboard(request, target)
                    break
                }
                guard actionNames(element).contains(axAction) else { throw HelperError.invalidRequest }
                guard AXUIElementPerformAction(element, axAction as CFString) == .success else { throw HelperError.unknownOutcome }
            case "desktop.scroll":
                guard let direction = request.direction, direction == "up" || direction == "down",
                      stringAttribute(element, kAXRoleAttribute) == kAXScrollBarRole,
                      let value = attribute(element, kAXValueAttribute) as? NSNumber else { throw HelperError.invalidRequest }
                var settable = DarwinBoolean(false)
                guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
                      settable.boolValue else { throw HelperError.invalidRequest }
                let next = max(0, min(1, value.doubleValue + (direction == "up" ? -0.1 : 0.1)))
                guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, NSNumber(value: next)) == .success else { throw HelperError.unknownOutcome }
            case "desktop.type":
                guard let text = request.text, text.utf8.count <= 4096,
                      [kAXTextFieldRole, kAXTextAreaRole, "AXSecureTextField"].contains(stringAttribute(element, kAXRoleAttribute)) else { throw HelperError.invalidRequest }
                var settable = DarwinBoolean(false)
                guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
                      settable.boolValue else { throw HelperError.invalidRequest }
                guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef) == .success else { throw HelperError.unknownOutcome }
            default: throw HelperError.invalidRequest
            }
        } else {
            switch request.action {
            case "desktop.click": try coordinateClick(request, target, window)
            case "desktop.drag": try coordinateDrag(request, target, window)
            case "desktop.scroll": try coordinateScroll(request, target, window)
            case "desktop.type", "desktop.key": try keyboard(request, target)
            default: throw HelperError.invalidRequest
            }
        }
        let settled: String
        do { settled = try settledRevision { try desktopSnapshot(target).1 } }
        catch { throw HelperError.unknownOutcome }
        if window.element != nil && settled != revision { return success(request.action, settled, effect: "changed") }
        // The bounded AX snapshot can miss changes (for example deep web content), so an unchanged tree is
        // confirmed against a small window image before reporting no effect.
        let imageAfter = await windowFingerprint(target)
        let effect = imageBefore == nil || imageAfter == nil
            ? (window.element == nil ? "unverified" : "unchanged")
            : imageBefore == imageAfter ? "unchanged" : "changed"
        return success(request.action, settled, effect: effect)
    case ("iterm.inspect", .iterm(let target)):
        return success(request.action, try inspectIterm(target).1)
    case ("iterm.send_text", .iterm(let target)):
        guard let expected = request.expectedRevision, let text = request.text else { throw HelperError.invalidRequest }
        let (application, revision) = try inspectIterm(target)
        guard revision == expected else { throw HelperError.staleRevision }
        try requireAutomation(application, eventClass: fourCC("Itrm"), eventID: fourCC("sntx"))
        do {
            _ = try send(
                application,
                eventClass: fourCC("Itrm"),
                eventID: fourCC("sntx"),
                directObject: try itermTarget(target).session,
                parameters: [
                    (fourCC("Text"), NSAppleEventDescriptor(string: text)),
                    (fourCC("Wtnl"), NSAppleEventDescriptor(boolean: request.newline ?? true)),
                ]
            )
            return success(request.action, try settledRevision { try inspectIterm(target).1 })
        } catch {
            throw HelperError.unknownOutcome
        }
    case ("finder.inspect", .finder(let target)):
        return success(request.action, try finderRevision(target).1)
    case ("finder.move", .finder(let target)):
        guard let expected = request.expectedRevision, let destination = request.destination else { throw HelperError.invalidRequest }
        let sourceURL = URL(fileURLWithPath: target.path).standardizedFileURL
        let destinationDirectory = URL(fileURLWithPath: destination).standardizedFileURL
        let destinationURL = destinationDirectory.appendingPathComponent(sourceURL.lastPathComponent)
        let (application, revision) = try finderRevision(target)
        guard revision == expected else { throw HelperError.staleRevision }
        var directory = ObjCBool(false)
        guard FileManager.default.fileExists(atPath: destinationDirectory.path, isDirectory: &directory), directory.boolValue else {
            throw HelperError.targetNotFound
        }
        guard !FileManager.default.fileExists(atPath: destinationURL.path) else { throw HelperError.targetConflict }
        guard let sourceAttributes = try? FileManager.default.attributesOfItem(atPath: sourceURL.path),
              let destinationAttributes = try? FileManager.default.attributesOfItem(atPath: destinationDirectory.path),
              (sourceAttributes[.systemNumber] as? NSNumber) == (destinationAttributes[.systemNumber] as? NSNumber) else {
            throw HelperError.invalidRequest
        }
        try requireAutomation(application, eventClass: UInt32(kAECoreSuite), eventID: UInt32(kAEMove))
        do {
            _ = try send(
                application,
                eventClass: UInt32(kAECoreSuite),
                eventID: UInt32(kAEMove),
                directObject: NSAppleEventDescriptor(fileURL: sourceURL),
                parameters: [(fourCC("insh"), NSAppleEventDescriptor(fileURL: destinationDirectory))]
            )
            return success(
                request.action,
                try settledRevision { try finderRevision(FinderTarget(platform: "macos", application: "finder", path: destinationURL.path)).1 }
            )
        } catch {
            throw HelperError.unknownOutcome
        }
    default:
        throw HelperError.invalidRequest
    }
}

private func encode(_ response: Response) -> Data? {
    try? JSONEncoder().encode(response)
}

private func writeResponse(_ response: Response, to destination: URL) -> Bool {
    guard let data = encode(response) else { return false }
    let temporary = destination.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
    guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { return false }
    do {
        try FileManager.default.moveItem(at: temporary, to: destination)
        return true
    } catch {
        try? FileManager.default.removeItem(at: temporary)
        return false
    }
}

private func holdAgentDisplay(_ request: Request, responseURL: URL) throws {
    guard !request.owner.sessionID.isEmpty, !request.owner.callID.isEmpty,
          let controlDirectory = request.controlDirectory, (controlDirectory as NSString).isAbsolutePath,
          let ownerPID = request.ownerPID, ownerPID > 0,
          (try? FileManager.default.attributesOfItem(atPath: controlDirectory)[.type] as? FileAttributeType) == .typeDirectory else {
        throw HelperError.invalidRequest
    }
    let descriptor = CGVirtualDisplayDescriptor()
    descriptor.queue = DispatchQueue.main
    descriptor.name = "YCoding Agent Display"
    descriptor.maxPixelsWide = 1920
    descriptor.maxPixelsHigh = 1200
    descriptor.sizeInMillimeters = CGSize(width: 300, height: 190)
    descriptor.productID = 0x1234
    descriptor.vendorID = 0x3456
    descriptor.serialNum = 0x0001
    guard let display = CGVirtualDisplay(descriptor: descriptor) else { throw HelperError.agentDisplayUnavailable }
    let settings = CGVirtualDisplaySettings()
    settings.modes = [CGVirtualDisplayMode(width: 1920, height: 1200, refreshRate: 60)]
    settings.hiDPI = 0
    guard display.apply(settings) else { throw HelperError.agentDisplayUnavailable }
    let deadline = Date().addingTimeInterval(5)
    var bounds = CGDisplayBounds(display.displayID)
    while (bounds.width <= 0 || bounds.height <= 0) && Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
        bounds = CGDisplayBounds(display.displayID)
    }
    guard display.displayID > 0, bounds.width > 0, bounds.height > 0 else { throw HelperError.agentDisplayUnavailable }
    let info = AgentDisplay(id: display.displayID, x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height)
    guard writeResponse(success(request.action, "", display: info), to: responseURL) else { throw HelperError.agentDisplayUnavailable }
    withExtendedLifetime(display) {
        while !FileManager.default.fileExists(atPath: URL(fileURLWithPath: controlDirectory).appendingPathComponent("stop").path),
              kill(ownerPID, 0) == 0 {
            let next = Date().addingTimeInterval(0.2)
            _ = RunLoop.current.run(mode: .default, before: next)
            let remaining = next.timeIntervalSinceNow
            if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
        }
    }
    try? FileManager.default.removeItem(atPath: controlDirectory)
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else { exit(64) }
let input = (try? Data(contentsOf: URL(fileURLWithPath: arguments[1]))) ?? Data()
let responseURL = URL(fileURLWithPath: arguments[2])
if let request = try? JSONDecoder().decode(Request.self, from: input), request.action == "display.hold" {
    do { try holdAgentDisplay(request, responseURL: responseURL) }
    catch let error as HelperError { _ = writeResponse(error.response, to: responseURL) }
    catch { _ = writeResponse(HelperError.agentDisplayUnavailable.response, to: responseURL) }
    exit(0)
}
private let response: Response
do { response = try await handle(JSONDecoder().decode(Request.self, from: input)) }
catch let error as HelperError { response = error.response }
catch { response = HelperError.invalidRequest.response }
_ = writeResponse(response, to: responseURL)
