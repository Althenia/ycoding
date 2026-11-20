import AppKit
import ApplicationServices
import LocalAuthentication

private let frameLimit = 1_048_576

private enum Operation: String, Decodable, Sendable {
    case hello, inventory, choose, attach, authorize, confirmIsolated, bindIsolated, startChromeEnrollmentMenu, presentEnrollment, observe, perform, preview, detach
}

private struct Command: Decodable, Sendable {
    let id: UInt32
    let generation: UUID
    let operation: Operation
    let ownerPID: Int32?
    let version: Int?
    let target: InteractionTarget?
    let lease: UUID?
    let revision: String?
    let action: String?
    let controlID: String?
    let text: String?
    let deltaY: Int?
    let destructive: Bool?
    let authorization: UUID?
    let isolated: IsolatedConsentRequest?
    let candidateID: UUID?
    let choices: WindowChoiceRequest?
    let enrollment: ChromeEnrollmentRequest?
    let enrollmentOrigin: String?
    let intentID: UUID?
}

private enum Consent: String, Encodable {
    case approved, denied
}

private struct Response: Encodable {
    var id: UInt32?
    let generation: UUID
    let state: String
    var code: Refusal?
    var lease: UUID?
    var targets: [TargetLabel]?
    var observation: WindowRead?
    var preview: WindowImage?
    var authorization: UUID?
    var consent: Consent?
    var selected: UUID?
    var presented: Bool?
    var candidateID: UUID?
    var intentID: UUID?
    var expiresAt: Int64?
}

private final class Output: @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.ycoding.interaction.output")

    func send(_ response: Response, afterDispatch: Bool = false, valid: @escaping () -> Bool = { true }) {
        queue.async {
            let encoder = JSONEncoder()
            guard let data = try? encoder.encode(response), data.count < frameLimit else { _exit(1) }
            guard valid() else {
                if let id = response.id {
                    self.write(Response(id: id, generation: response.generation,
                        state: afterDispatch ? "uncertain" : "refused", code: afterDispatch ? .uncertain : .stopped))
                }
                return
            }
            self.write(data)
        }
    }

    private func write(_ response: Response) {
        guard let data = try? JSONEncoder().encode(response), data.count < frameLimit else { _exit(1) }
        write(data)
    }

    private func write(_ data: Data) {
        do {
            var line = data
            line.append(10)
            try FileHandle.standardOutput.write(contentsOf: line)
        } catch { _exit(1) }
    }
}

private actor Worker {
    func run(_ command: Command, lease: UUID, target: InteractionTarget, fence: InteractionFence) async throws -> Response {
        try fence.check(lease, target: target, revision: command.operation == .observe ? nil : command.revision)
        switch command.operation {
        case .observe:
            let observation = try WindowHost.observe(target)
            try fence.observed(lease, target: target, revision: observation.revision)
            return Response(id: command.id, generation: command.generation, state: "ok", lease: lease, observation: observation)
        case .perform:
            guard let revision = command.revision, let action = command.action else { throw Refusal.invalidRequest }
            try WindowHost.perform(target, revision: revision, controlID: command.controlID, action: action, text: command.text, deltaY: command.deltaY) {
                try fence.dispatch(lease, target: target, revision: revision)
            }
            do { try fence.check(lease, target: target) } catch { throw Refusal.uncertain }
            return Response(id: command.id, generation: command.generation, state: "ok", lease: lease)
        default: throw Refusal.invalidRequest
        }
    }

    func preview(lease: UUID, target: InteractionTarget, fence: InteractionFence) async throws -> (frame: WindowImage, verify: PreviewFence) {
        try await fence.capture(lease, target: target) { verify in
            try await WindowHost.preview(target, verify: verify)
        }
    }
}

@MainActor
private final class Service {
    private struct Binding {
        let lease: UUID
        let target: InteractionTarget
        let generation: UUID
        let panel: ControlPanel
    }

    private struct Confirmation {
        let id: UUID
        let lease: UUID
        let target: InteractionTarget
        let revision: String
        let action: String
        let controlID: String
        let text: String?
        let expiry: ContinuousClock.Instant

        func matches(_ command: Command) -> Bool {
            id == command.authorization && lease == command.lease && target == command.target && revision == command.revision
                && action == command.action && controlID == command.controlID && text == command.text && expiry > .now
        }
    }

    private let fence: InteractionFence
    private let output: Output
    private let worker = Worker()
    private var binding: Binding?
    private var context: LAContext?
    private var monitoring: Timer?
    private var confirmation: Confirmation?
    private var isolated = IsolatedConsentFence()
    private var isolatedChannel = false
    private var isolatedPanel: ControlPanel?
    private var chooserUsed = false
    private var enrollmentMenu: ChromeEnrollmentMenu?
    private var enrollmentOrigin: String?
    private var enrollmentIntent = ChromeEnrollmentIntentFence()
    private var enrollmentTimeout: Timer?
    private var enrollmentPanel: ChromeEnrollmentPanel?

    init(fence: InteractionFence, output: Output) {
        self.fence = fence
        self.output = output
    }

    func accept(_ command: Command) async {
        do {
            if chooserUsed || enrollmentMenu != nil && command.operation != .presentEnrollment
                || isolatedChannel && command.operation != .confirmIsolated && command.operation != .bindIsolated {
                throw Refusal.invalidRequest
            }
            switch command.operation {
            case .hello:
                output.send(Response(id: command.id, generation: command.generation, state: "ok"))
            case .inventory:
                let labels = try await Task.detached { try WindowHost.inventory() }.value
                output.send(Response(id: command.id, generation: command.generation, state: "ok", targets: labels))
            case .choose:
                chooserUsed = true
                let selected = await choose(command.choices)
                output.send(Response(id: command.id, generation: command.generation, state: "ok", selected: selected))
            case .attach:
                guard let target = command.target else { throw Refusal.invalidRequest }
                try await attach(target, command: command)
            case .confirmIsolated:
                let consent = await confirmIsolated(command.isolated, generation: command.generation)
                output.send(Response(id: command.id, generation: command.generation, state: "ok", consent: consent, candidateID: command.isolated?.candidateID))
            case .bindIsolated:
                guard isolatedChannel, let candidateID = command.candidateID, let lease = command.lease,
                      WindowHost.awake(), isolatedPanel?.visible == true,
                      isolated.bind(candidateID: candidateID, lease: lease, now: Int64(Date.now.timeIntervalSince1970 * 1000)) else {
                    throw Refusal.notAuthorized
                }
                output.send(Response(id: command.id, generation: command.generation, state: "ok", lease: lease, candidateID: candidateID))
            case .startChromeEnrollmentMenu:
                guard binding == nil, context == nil, let origin = command.enrollmentOrigin, ChromeEnrollmentRequest.validOrigin(origin),
                      let menu = ChromeEnrollmentMenu(select: { [weak self] in
                          Task { @MainActor in await self?.connectChrome(origin: origin, generation: command.generation) }
                      }) else { throw Refusal.unavailable }
                enrollmentOrigin = origin
                enrollmentMenu = menu
                output.send(Response(id: command.id, generation: command.generation, state: "ok"))
            case .presentEnrollment:
                guard let origin = enrollmentOrigin, let intentID = command.intentID else { throw Refusal.notAuthorized }
                let presented = await presentEnrollment(command.enrollment, origin: origin, intentID: intentID, generation: command.generation)
                output.send(Response(id: command.id, generation: command.generation, state: "ok", presented: presented, intentID: intentID))
            case .detach:
                guard let lease = command.lease else { throw Refusal.invalidRequest }
                stop(lease, report: false)
                output.send(Response(id: command.id, generation: command.generation, state: "ok"))
            case .authorize, .observe, .perform, .preview:
                guard let lease = command.lease, let target = command.target, let active = binding,
                      active.lease == lease, active.generation == command.generation else { throw Refusal.stopped }
                guard active.panel.visible else {
                    stop(lease)
                    throw Refusal.stopped
                }
                if command.operation == .authorize {
                    try await authorize(command, lease: lease, target: target)
                    return
                }
                if command.operation == .preview {
                    let preview = try await worker.preview(lease: lease, target: target, fence: fence)
                    guard active.panel.visible else { stop(lease); throw Refusal.stopped }
                    output.send(Response(id: command.id, generation: command.generation, state: "ok", lease: lease, preview: preview.frame)) {
                        (try? preview.verify()) != nil
                    }
                    return
                }
                if command.operation == .perform, command.action == "press" || command.destructive == true {
                    guard confirmation?.matches(command) == true else { throw Refusal.confirmationRequired }
                    confirmation = nil
                }
                let response = try await worker.run(command, lease: lease, target: target, fence: fence)
                output.send(response, afterDispatch: command.operation == .perform) { [fence] in
                    (try? fence.check(lease, target: target)) != nil
                }
            }
        } catch {
            let code = error as? Refusal ?? .unavailable
            if let lease = command.lease, code == .targetChanged || code == .permissionMissing {
                stop(lease)
            }
            output.send(Response(id: command.id, generation: command.generation, state: code == .uncertain ? "uncertain" : "refused", code: code))
            if let lease = command.lease, code == .uncertain { stop(lease) }
        }
    }

    private func connectChrome(origin: String, generation: UUID) async {
        let id = UUID()
        guard WindowHost.awake(), enrollmentIntent.select(id) else { return }
        let approved = (try? await authenticate("Connect Chrome to YCoding at \(origin)")) != nil && WindowHost.awake()
        guard let expiresAt = enrollmentIntent.authenticate(id, approved: approved, now: Int64(Date.now.timeIntervalSince1970 * 1000)) else { return }
        let timer = Timer(fire: Date(timeIntervalSince1970: TimeInterval(expiresAt) / 1000), interval: 0, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.retireEnrollment(id, generation: generation) }
        }
        enrollmentTimeout = timer
        RunLoop.main.add(timer, forMode: .common)
        output.send(Response(generation: generation, state: "chromeEnrollmentIntent", intentID: id, expiresAt: expiresAt))
    }

    private func presentEnrollment(_ request: ChromeEnrollmentRequest?, origin: String, intentID: UUID, generation: UUID) async -> Bool {
        guard let request else { retireEnrollment(intentID, generation: generation); return false }
        let now = Int64(Date.now.timeIntervalSince1970 * 1000)
        guard enrollmentIntent.claim(intentID, now: now) else { return false }
        enrollmentTimeout?.invalidate()
        enrollmentTimeout = nil
        guard WindowHost.awake(), request.origin == origin, request.valid(now: now),
              let panel = ChromeEnrollmentPanel(request, dismissed: { [weak self] in self?.retireEnrollment(intentID, generation: generation) }) else {
            retireEnrollment(intentID, generation: generation)
            return false
        }
        enrollmentPanel = panel
        guard await panel.show() else { retireEnrollment(intentID, generation: generation); return false }
        return true
    }

    private func retireEnrollment(_ id: UUID, generation: UUID) {
        guard enrollmentIntent.retire(id) else { return }
        enrollmentTimeout?.invalidate()
        enrollmentTimeout = nil
        enrollmentPanel?.hide()
        enrollmentPanel = nil
        output.send(Response(generation: generation, state: "chromeEnrollmentEnded", intentID: id))
    }

    private func choose(_ request: WindowChoiceRequest?) async -> UUID? {
        guard let request, binding == nil, context == nil, WindowHost.awake(),
              request.valid(now: Int64(Date.now.timeIntervalSince1970 * 1000)) else { return nil }
        let options = request.windows.compactMap { window -> (UUID, String)? in
            guard let identity = try? WindowHost.consentDescription(window.target) else { return nil }
            return (window.id, "\(safeLabel(identity.app)) · Window \(window.target.windowID) — \(safeLabel(identity.title))")
        }
        guard let chooser = WindowChooser(options: options), let selected = await chooser.select(until: request.expiresAt),
              let target = request.selection(selected, now: Int64(Date.now.timeIntervalSince1970 * 1000)),
              (try? WindowHost.verifyTarget(target)) != nil else { return nil }
        return selected
    }

    private func confirmIsolated(_ request: IsolatedConsentRequest?, generation: UUID) async -> Consent {
        guard WindowHost.awake(), binding == nil, context == nil || isolatedChannel, let request else { return .denied }
        isolatedChannel = true
        guard isolated.begin(request, now: Int64(Date.now.timeIntervalSince1970 * 1000)) else {
            stopIsolated(generation)
            return .denied
        }
        guard (try? await authenticate("Allow YCoding to open isolated Chrome at \(request.url)")) != nil,
              WindowHost.awake(), request.valid(now: Int64(Date.now.timeIntervalSince1970 * 1000)),
              let host = URLComponents(string: request.url)?.host,
              let panel = ControlPanel(app: "Isolated Chrome", scope: safeLabel(host), stop: { [weak self] in self?.stopIsolated(generation) }) else {
            _ = isolated.stop()
            return .denied
        }
        isolatedPanel = panel
        let shown = await panel.show()
        guard isolated.finish(request, visible: shown && panel.visible && WindowHost.awake(), now: Int64(Date.now.timeIntervalSince1970 * 1000)) else {
            stopIsolated(generation)
            return .denied
        }
        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.isolatedPanel?.visible != true || !WindowHost.awake()
                    || !self.isolated.live(now: Int64(Date.now.timeIntervalSince1970 * 1000)) {
                    self.stopIsolated(generation)
                }
            }
        }
        monitoring = timer
        RunLoop.main.add(timer, forMode: .common)
        return .approved
    }

    private func stopIsolated(_ generation: UUID) {
        let id = isolated.stop()
        context?.invalidate()
        context = nil
        monitoring?.invalidate()
        monitoring = nil
        isolatedPanel?.hide()
        isolatedPanel = nil
        if let id { output.send(Response(generation: generation, state: "stopped", lease: id)) }
    }

    private func attach(_ target: InteractionTarget, command: Command) async throws {
        guard AXIsProcessTrusted() else { throw Refusal.permissionMissing }
        let description = try WindowHost.consentDescription(target)
        let lease = try fence.begin(target)
        let app = safeLabel(description.app)
        let title = safeLabel(description.title)
        do {
            try await authenticate("Allow YCoding to observe and control \(app), window \(target.windowID): \(title)")
            try WindowHost.verifyTarget(target)
            guard let panel = ControlPanel(app: app, scope: "Window \(target.windowID)", stop: { [weak self] in self?.stop(lease) }) else {
                throw Refusal.unavailable
            }
            guard await panel.show() else {
                panel.hide()
                throw Refusal.notAuthorized
            }
            do { try fence.activate(lease, target: target, visible: panel.visible) } catch {
                panel.hide()
                throw error
            }
            binding = Binding(lease: lease, target: target, generation: command.generation, panel: panel)
            let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.checkBinding() }
            }
            RunLoop.main.add(timer, forMode: .common)
            monitoring = timer
            output.send(Response(id: command.id, generation: command.generation, state: "ok", lease: lease)) { [fence] in
                (try? fence.check(lease, target: target)) != nil
            }
        } catch {
            fence.stop(lease)
            throw error
        }
    }

    private func authorize(_ command: Command, lease: UUID, target: InteractionTarget) async throws {
        guard let revision = command.revision, let controlID = command.controlID, let action = command.action,
              action == "press" || (action == "replaceText" && command.destructive == true) else { throw Refusal.invalidRequest }
        try fence.check(lease, target: target, revision: revision)
        let label = try await Task.detached { try WindowHost.confirm(target, revision: revision, controlID: controlID, action: action) }.value
        let app = try WindowHost.consentDescription(target).app
        let verb = action == "press" ? "press" : "replace the value of"
        try await authenticate("Allow YCoding to \(verb) \(safeLabel(label)) in \(safeLabel(app)), window \(target.windowID)")
        try fence.check(lease, target: target, revision: revision)
        let value = Confirmation(id: UUID(), lease: lease, target: target, revision: revision, action: action,
            controlID: controlID, text: command.text, expiry: .now.advanced(by: .seconds(60)))
        confirmation = value
        output.send(Response(id: command.id, generation: command.generation, state: "ok", lease: lease, authorization: value.id)) { [fence] in
            (try? fence.check(lease, target: target, revision: revision)) != nil
        }
    }

    private func authenticate(_ reason: String) async throws {
        guard context == nil else { throw Refusal.busy }
        let auth = LAContext()
        auth.touchIDAuthenticationAllowableReuseDuration = 0
        auth.localizedCancelTitle = "Cancel"
        context = auth
        defer {
            auth.invalidate()
            if context === auth { context = nil }
        }
        do {
            guard try await auth.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else { throw Refusal.notAuthorized }
        } catch { throw Refusal.notAuthorized }
    }

    private func safeLabel(_ label: String) -> String {
        String(label.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && $0.properties.generalCategory != .format })
    }

    private func checkBinding() {
        guard let active = binding else { return }
        if !active.panel.visible || (try? fence.check(active.lease, target: active.target)) == nil
            || (try? WindowHost.verifyTarget(active.target)) == nil || !AXIsProcessTrusted() {
            stop(active.lease)
        }
    }

    private func stop(_ lease: UUID, report: Bool = true) {
        fence.stop(lease)
        guard let active = binding, active.lease == lease else { return }
        binding = nil
        confirmation = nil
        monitoring?.invalidate()
        monitoring = nil
        context?.invalidate()
        context = nil
        active.panel.hide()
        if report { output.send(Response(generation: active.generation, state: "stopped", lease: lease)) }
    }
}

@main
struct InteractionService {
    @MainActor
    static func main() {
        let ownerPID = getppid()
        guard ownerPID > 1, pipe(STDIN_FILENO), pipe(STDOUT_FILENO) else { _exit(1) }
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        guard app.setActivationPolicy(.accessory) else { _exit(1) }
        let fence = InteractionFence()
        let output = Output()
        let service = Service(fence: fence, output: output)
        DispatchQueue.global(qos: .userInitiated).async {
            let owner = DispatchSource.makeProcessSource(identifier: ownerPID, eventMask: .exit)
            owner.setEventHandler { fence.stop(); _exit(0) }
            owner.resume()
            withExtendedLifetime(owner) {
                receive(ownerPID: ownerPID, fence: fence) { command in
                    Task { @MainActor in await service.accept(command) }
                }
            }
        }
        app.run()
    }

    private static func pipe(_ fd: Int32) -> Bool {
        var info = stat()
        guard fstat(fd, &info) == 0 else { return false }
        let type = info.st_mode & S_IFMT
        return type == S_IFIFO || type == S_IFSOCK
    }

    private static func receive(ownerPID: Int32, fence: InteractionFence, handle: (Command) -> Void) {
        var bytes = [UInt8](repeating: 0, count: 4096)
        var line = Data()
        var generation: UUID?
        var lastID: UInt32 = 0
        let decoder = JSONDecoder()
        while getppid() == ownerPID {
            let count = bytes.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { break }
            for byte in bytes.prefix(count) {
                if byte != 10 {
                    guard line.count < frameLimit else { fence.stop(); _exit(1) }
                    line.append(byte)
                    continue
                }
                guard let command = try? decoder.decode(Command.self, from: line), command.id > lastID else { fence.stop(); _exit(1) }
                line.removeAll(keepingCapacity: true)
                lastID = command.id
                if let generation {
                    guard generation == command.generation, command.operation != .hello,
                          command.version == nil, command.ownerPID == nil else { fence.stop(); _exit(1) }
                } else {
                    guard command.operation == .hello, command.ownerPID == ownerPID, command.version == 1 else { fence.stop(); _exit(1) }
                    generation = command.generation
                }
                if command.operation == .detach, let lease = command.lease { fence.stop(lease) }
                handle(command)
            }
        }
        fence.stop()
        _exit(0)
    }
}
