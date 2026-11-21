import AppKit
import ApplicationServices
import CryptoKit

@main
struct FocusSampler {
    private typealias AXWindowID = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

    @MainActor
    static func main() {
        let arguments = CommandLine.arguments.dropFirst()
        let interval = arguments.firstIndex(of: "--interval-ms").flatMap { arguments.index(after: $0) < arguments.endIndex ? Double(arguments[arguments.index(after: $0)]) : nil } ?? 50
        let label = Label(arguments.firstIndex(of: "--label").flatMap { arguments.index(after: $0) < arguments.endIndex ? arguments[arguments.index(after: $0)] : nil } ?? "unlabeled")
        let salt = UUID().uuidString
        let windowID: AXWindowID? = {
            guard let library = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY | RTLD_LOCAL),
                  let symbol = dlsym(library, "_AXUIElementGetWindow") else { return nil }
            return unsafeBitCast(symbol, to: AXWindowID.self)
        }()
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.1)
        signal(SIGPIPE, SIG_IGN)

        func attribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
            var value: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let value,
                  CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
            return (value as! AXUIElement)
        }
        func pid(_ element: AXUIElement) -> Int32? {
            var pid: pid_t = 0
            return AXUIElementGetPid(element, &pid) == .success ? pid : nil
        }
        func opaque(_ element: AXUIElement) -> String {
            let digest = SHA256.hash(data: Data("\(salt):\(CFHash(element))".utf8))
            return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        }
        func focus(_ front: NSRunningApplication?) -> Any {
            guard AXIsProcessTrusted() else { return NSNull() }
            let systemApp = attribute(system, kAXFocusedApplicationAttribute)
            guard let app = systemApp ?? front.map({ AXUIElementCreateApplication($0.processIdentifier) }) else { return NSNull() }
            AXUIElementSetMessagingTimeout(app, 0.1)
            let source = systemApp == nil ? "frontmost" : "system"
            let focusedElement = systemApp == nil ? attribute(app, kAXFocusedUIElementAttribute) : attribute(system, kAXFocusedUIElementAttribute)
            let window: Any = attribute(app, kAXFocusedWindowAttribute).map { window -> [String: Any] in
                var number: CGWindowID = 0
                let id: Any = windowID.map { $0(window, &number) == .success } == true ? Int(number) : opaque(window)
                return ["pid": pid(window) ?? -1, "id": id]
            } ?? NSNull()
            let element: Any = focusedElement.map { element -> [String: Any] in
                var role: CFTypeRef?
                AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
                return ["pid": pid(element) ?? -1, "role": role as? String ?? "", "id": opaque(element)]
            } ?? NSNull()
            return ["appPID": pid(app) ?? -1, "window": window, "element": element, "source": source]
        }
        func sample() {
            let front = NSWorkspace.shared.frontmostApplication
            let cursor = CGEvent(source: nil)?.location ?? .zero
            let record: [String: Any] = [
                "t": Int64(Date.now.timeIntervalSince1970 * 1000),
                "label": label.value,
                "front": front.map { ["pid": $0.processIdentifier, "bundleID": $0.bundleIdentifier ?? ""] } ?? NSNull(),
                "cursor": ["x": Double(cursor.x), "y": Double(cursor.y)],
                "focus": focus(front),
                "hidIdleSeconds": CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!),
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        }

        Thread.detachNewThread {
            while let line = readLine() {
                let next = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !next.isEmpty else { continue }
                DispatchQueue.main.async { label.value = next; sample() }
            }
        }
        let stop = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { sample(); exit(0) }
            source.resume()
            return source
        }
        let timer = Timer(timeInterval: interval / 1000, repeats: true) { _ in MainActor.assumeIsolated { sample() } }
        RunLoop.main.add(timer, forMode: .common)
        sample()
        withExtendedLifetime((stop, timer)) { RunLoop.main.run() }
    }
}

@MainActor
private final class Label {
    var value: String
    init(_ value: String) { self.value = value }
}
