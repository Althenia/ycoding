import AppKit
import Carbon
import CryptoKit
import Foundation

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

private struct Request: Decodable {
    let action: String
    let owner: Owner
    let target: Target
    let expectedRevision: String?
    let text: String?
    let newline: Bool?
    let destination: String?

    enum Target: Decodable {
        case iterm(ItermTarget)
        case finder(FinderTarget)

        private enum CodingKeys: String, CodingKey { case platform, application }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            guard try container.decode(String.self, forKey: .platform) == "macos" else {
                throw HelperError.invalidRequest
            }
            switch try container.decode(String.self, forKey: .application) {
            case "iterm": self = .iterm(try ItermTarget(from: decoder))
            case "finder": self = .finder(try FinderTarget(from: decoder))
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

    var response: Response {
        switch self {
        case .invalidRequest:
            return failure("invalid_request", "The native request is invalid")
        case .appNotRunning:
            return failure("app_not_running", "The requested application is not running")
        case .automationDenied:
            return failure("automation_denied", "Automation access is unavailable; no permission prompt was shown")
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
        }
    }
}

private func failure(_ code: String, _ message: String, outcome: String = "not_started") -> Response {
    Response(status: "error", action: nil, revision: nil, code: code, message: message, outcome: outcome)
}

private func success(_ action: String, _ revision: String) -> Response {
    Response(status: "ok", action: action, revision: revision, code: nil, message: nil, outcome: nil)
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
    let status = AEDeterminePermissionToAutomateTarget(
        target.descriptor.aeDesc,
        AEEventClass(eventClass),
        AEEventID(eventID),
        false
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

private func handle(_ request: Request) throws -> Response {
    guard !request.owner.sessionID.isEmpty, !request.owner.callID.isEmpty else { throw HelperError.invalidRequest }
    switch (request.action, request.target) {
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

private func write(_ response: Response) {
    guard let data = try? JSONEncoder().encode(response) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    write(try handle(JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())))
} catch let error as HelperError {
    write(error.response)
} catch {
    write(HelperError.invalidRequest.response)
}
