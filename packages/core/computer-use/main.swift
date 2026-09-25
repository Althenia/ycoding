import AppKit
import ApplicationServices
import Carbon
import CryptoKit
import Foundation
import CoreGraphics
import ScreenCaptureKit

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

private struct Element: Encodable {
    let path: [Int]
    let role: String
    let label: String
}

private struct Request: Decodable {
    let action: String
    let owner: Owner
    let target: Target
    let expectedRevision: String?
    let text: String?
    let newline: Bool?
    let destination: String?
    let element: [Int]?
    let direction: String?
    let key: String?

    enum Target: Decodable {
        case iterm(ItermTarget)
        case finder(FinderTarget)
        case desktop(DesktopTarget)

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
    case unknownOutcome
    case accessibilityDenied
    case screenRecordingDenied

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
        case .unknownOutcome:
            return failure("unknown_outcome", "The native command may have been accepted; inspect before any further mutation", outcome: "unknown")
        case .accessibilityDenied:
            return failure("accessibility_denied", "Allow YCoding Computer Use in System Settings > Privacy & Security > Accessibility, then retry")
        case .screenRecordingDenied:
            return failure("screen_recording_denied", "Allow YCoding Computer Use in System Settings > Privacy & Security > Screen Recording, then retry")
        }
    }
}

private func failure(_ code: String, _ message: String, outcome: String = "not_started") -> Response {
    Response(status: "error", action: nil, revision: nil, code: code, message: message, outcome: outcome, elements: nil, image: nil)
}

private func success(_ action: String, _ revision: String, elements: [Element]? = nil, image: String? = nil) -> Response {
    Response(status: "ok", action: action, revision: revision, code: nil, message: nil, outcome: nil, elements: elements, image: image)
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
    (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(16).map { $0 }
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
    let element: AXUIElement
    let bounds: CGRect
}

private func desktopWindow(_ target: DesktopTarget) throws -> DesktopWindow {
    guard target.platform == "macos", target.application == "desktop", !target.bundleID.isEmpty,
          target.pid > 0, target.windowID > 0,
          let app = NSRunningApplication(processIdentifier: target.pid),
          app.bundleIdentifier == target.bundleID, !app.isTerminated else { throw HelperError.appNotRunning }
    // Requesting trust lets macOS list this app under Accessibility and show its own allow prompt.
    guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) else {
        throw HelperError.accessibilityDenied
    }
    guard let windows = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(target.windowID)) as? [[String: Any]],
          windows.count == 1, let info = windows.first,
          (info[kCGWindowOwnerPID as String] as? Int) == Int(target.pid),
          (info[kCGWindowLayer as String] as? Int) == 0,
          let dictionary = info[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary), bounds.width > 0, bounds.height > 0 else {
        throw HelperError.targetNotFound
    }
    let application = AXUIElementCreateApplication(target.pid)
    AXUIElementSetMessagingTimeout(application, 5)
    let listed = (attribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter { windowID($0) == target.windowID }
    let onscreen = (info[kCGWindowIsOnscreen as String] as? Bool) == true
    let matches = listed.isEmpty && !onscreen ? offSpaceWindows(target) : listed
    guard matches.count == 1, let match = matches.first else { throw HelperError.targetNotFound }
    AXUIElementSetMessagingTimeout(match, 5)
    return DesktopWindow(element: match, bounds: bounds)
}

private func desktopSnapshot(_ target: DesktopTarget) throws -> (DesktopWindow, String, [Element]) {
    let window = try desktopWindow(target)
    var entries: [Element] = []
    var revisionParts = [target.bundleID, String(target.pid), String(target.windowID), NSStringFromRect(window.bounds), stringAttribute(window.element, kAXTitleAttribute)]
    func visit(_ node: AXUIElement, path: [Int]) {
        guard entries.count < 64 else { return }
        let role = stringAttribute(node, kAXRoleAttribute)
        let label = stringAttribute(node, kAXTitleAttribute).isEmpty ? stringAttribute(node, kAXDescriptionAttribute) : stringAttribute(node, kAXTitleAttribute)
        entries.append(Element(path: path, role: role, label: label))
        let rawValue = attribute(node, kAXValueAttribute)
        let value = (rawValue as? String)?.prefix(512).description ?? (rawValue as? NSNumber)?.stringValue ?? ""
        revisionParts.append("\(path):\(role):\(label):\(value):\(stringAttribute(node, kAXEnabledAttribute)):\(stringAttribute(node, kAXFocusedAttribute))")
        guard path.count < 5 else { return }
        for (index, child) in children(node).enumerated() { visit(child, path: path + [index]) }
    }
    visit(window.element, path: [])
    return (window, sha256(revisionParts), entries)
}

private func desktopElement(_ window: AXUIElement, path: [Int]) throws -> AXUIElement {
    guard path.count <= 5, path.allSatisfy({ $0 >= 0 && $0 < 16 }) else { throw HelperError.invalidRequest }
    return try path.reduce(window) { parent, index in
        let nodes = children(parent)
        guard index < nodes.count else { throw HelperError.targetNotFound }
        return nodes[index]
    }
}

private func captureWindow(_ target: DesktopTarget) async throws -> String {
    guard #available(macOS 14, *) else { throw HelperError.nativeFailure }
    guard CGRequestScreenCaptureAccess() else { throw HelperError.screenRecordingDenied }
    _ = try desktopWindow(target)
    let windows: [SCWindow]
    do { windows = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false).windows }
    catch { throw HelperError.nativeFailure }
    guard let source = windows.first(where: { $0.windowID == target.windowID && $0.owningApplication?.processID == target.pid && $0.owningApplication?.bundleIdentifier == target.bundleID }) else { throw HelperError.targetNotFound }
    let filter = SCContentFilter(desktopIndependentWindow: source)
    let configuration = SCStreamConfiguration()
    let scale = min(1, 320 / max(1, source.frame.width), 240 / max(1, source.frame.height))
    configuration.width = max(1, Int(source.frame.width * scale))
    configuration.height = max(1, Int(source.frame.height * scale))
    configuration.showsCursor = false
    let image: CGImage
    do { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) }
    catch { throw HelperError.nativeFailure }
    _ = try desktopWindow(target)
    guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.4]),
          jpeg.count <= 40_000 else { throw HelperError.nativeFailure }
    return jpeg.base64EncodedString()
}

private func handle(_ request: Request) async throws -> Response {
    guard !request.owner.sessionID.isEmpty, !request.owner.callID.isEmpty else { throw HelperError.invalidRequest }
    switch (request.action, request.target) {
    case ("desktop.inspect", .desktop(let target)):
        let (_, revision, elements) = try desktopSnapshot(target)
        return success(request.action, revision, elements: elements)
    case ("desktop.capture", .desktop(let target)):
        let (_, revision, _) = try desktopSnapshot(target)
        return success(request.action, revision, image: try await captureWindow(target))
    case ("desktop.click", .desktop(let target)),
         ("desktop.type", .desktop(let target)),
         ("desktop.scroll", .desktop(let target)),
         ("desktop.key", .desktop(let target)):
        guard let expected = request.expectedRevision, let path = request.element else { throw HelperError.invalidRequest }
        let (window, revision, _) = try desktopSnapshot(target)
        guard revision == expected else { throw HelperError.staleRevision }
        let element = try desktopElement(window.element, path: path)
        let axAction: String
        switch request.action {
        case "desktop.click": axAction = kAXPressAction
        case "desktop.key":
            guard request.key == "enter" else { throw HelperError.invalidRequest }
            axAction = kAXConfirmAction
        case "desktop.scroll":
            guard let direction = request.direction, direction == "up" || direction == "down" else { throw HelperError.invalidRequest }
            guard stringAttribute(element, kAXRoleAttribute) == kAXScrollBarRole,
                  let value = attribute(element, kAXValueAttribute) as? NSNumber else { throw HelperError.invalidRequest }
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
                  settable.boolValue else { throw HelperError.invalidRequest }
            let next = max(0, min(1, value.doubleValue + (direction == "up" ? -0.1 : 0.1)))
            guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, NSNumber(value: next)) == .success else { throw HelperError.unknownOutcome }
            do { return success(request.action, try desktopSnapshot(target).1) }
            catch { throw HelperError.unknownOutcome }
        case "desktop.type":
            guard let text = request.text, text.utf8.count <= 4096,
                  stringAttribute(element, kAXRoleAttribute) == kAXTextFieldRole ||
                  stringAttribute(element, kAXRoleAttribute) == kAXTextAreaRole else { throw HelperError.invalidRequest }
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
                  settable.boolValue else { throw HelperError.invalidRequest }
            let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
            guard result == .success else { throw HelperError.unknownOutcome }
            do { return success(request.action, try desktopSnapshot(target).1) }
            catch { throw HelperError.unknownOutcome }
        default: throw HelperError.invalidRequest
        }
        var actions: CFArray?
        guard AXUIElementCopyActionNames(element, &actions) == .success,
              (actions as? [String])?.contains(axAction) == true else { throw HelperError.invalidRequest }
        guard AXUIElementPerformAction(element, axAction as CFString) == .success else { throw HelperError.unknownOutcome }
        do { return success(request.action, try desktopSnapshot(target).1) }
        catch { throw HelperError.unknownOutcome }
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
            return success(request.action, try inspectIterm(target).1)
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
                try finderRevision(FinderTarget(platform: "macos", application: "finder", path: destinationURL.path)).1
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

let arguments = CommandLine.arguments
guard arguments.count == 3 else { exit(64) }
let input = (try? Data(contentsOf: URL(fileURLWithPath: arguments[1]))) ?? Data()
private let response: Response
do { response = try await handle(JSONDecoder().decode(Request.self, from: input)) }
catch let error as HelperError { response = error.response }
catch { response = HelperError.invalidRequest.response }
if let data = encode(response) {
    let destination = URL(fileURLWithPath: arguments[2])
    let temporary = destination.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
    if FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) {
        try? FileManager.default.moveItem(at: temporary, to: destination)
    }
}
