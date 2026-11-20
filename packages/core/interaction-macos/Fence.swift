import Foundation

struct InteractionTarget: Codable, Hashable, Sendable {
    let pid: Int32
    let started: String
    let bundleID: String
    let windowID: UInt32
}

struct WindowChoice: Decodable, Sendable {
    let id: UUID
    let target: InteractionTarget
}

struct WindowChoiceRequest: Decodable, Sendable {
    let candidateID: UUID
    let sessionID: String
    let expiresAt: Int64
    let windows: [WindowChoice]

    func valid(now: Int64) -> Bool {
        expiresAt > now && expiresAt - now <= 60_000 && validSessionID(sessionID) && !windows.isEmpty && windows.count <= 64
            && Set(windows.map(\.id)).count == windows.count && Set(windows.map(\.target)).count == windows.count
    }

    func selection(_ id: UUID, now: Int64) -> InteractionTarget? {
        guard valid(now: now) else { return nil }
        return windows.first { $0.id == id }?.target
    }
}

private func validSessionID(_ value: String) -> Bool {
    value.hasPrefix("ses") && value.utf8.count <= 128
        && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
}

struct IsolatedConsentRequest: Decodable, Equatable, Sendable {
    let candidateID: UUID
    let sessionID: String
    let url: String
    let expiresAt: Int64

    func valid(now: Int64) -> Bool {
        guard expiresAt > now, expiresAt - now <= 60_000,
              validSessionID(sessionID),
              url.utf8.count <= 2048, url.utf8.allSatisfy({ (33...126).contains($0) && $0 != 92 }),
              let parts = URLComponents(string: url), parts.scheme == "https" || parts.scheme == "http",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil, parts.url != nil else { return false }
        return true
    }
}

struct IsolatedConsentFence {
    private enum State {
        case fresh, pending(IsolatedConsentRequest), armed(candidateID: UUID, expiresAt: Int64), bound(UUID), stopped
    }

    private var state = State.fresh

    mutating func begin(_ request: IsolatedConsentRequest, now: Int64) -> Bool {
        guard case .fresh = state else {
            if case .pending = state { state = .stopped }
            return false
        }
        guard request.valid(now: now) else { return false }
        state = .pending(request)
        return true
    }

    mutating func finish(_ request: IsolatedConsentRequest, visible: Bool, now: Int64) -> Bool {
        guard case .pending(let pending) = state else { return false }
        guard visible, pending == request, pending.valid(now: now) else { state = .stopped; return false }
        state = .armed(candidateID: request.candidateID, expiresAt: request.expiresAt)
        return true
    }

    mutating func bind(candidateID: UUID, lease: UUID, now: Int64) -> Bool {
        guard case .armed(let candidate, let expiresAt) = state, candidateID == candidate, now < expiresAt else { return false }
        state = .bound(lease)
        return true
    }

    func live(now: Int64) -> Bool {
        switch state {
        case .armed(_, let expiresAt): now < expiresAt
        case .bound: true
        default: false
        }
    }

    mutating func stop() -> UUID? {
        defer { state = .stopped }
        switch state {
        case .pending(let request): return request.candidateID
        case .armed(let candidate, _): return candidate
        case .bound(let lease): return lease
        default: return nil
        }
    }
}

struct ChromeEnrollmentRequest: Decodable, Sendable {
    let origin: String
    let code: String
    let expiresAt: Int64

    func valid(now: Int64) -> Bool {
        guard expiresAt > now, expiresAt - now <= 60_000, Self.validOrigin(origin), code.utf8.count == 43 else { return false }
        return code.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
    }

    static func validOrigin(_ origin: String) -> Bool {
        guard origin.utf8.count <= 128, let url = URLComponents(string: origin), url.scheme == "http",
              let host = url.host, ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) else { return false }
        return url.user == nil && url.password == nil && url.path.isEmpty && url.query == nil && url.fragment == nil
    }
}

struct ChromeEnrollmentIntentFence {
    private enum State {
        case idle, authenticating(UUID), offered(UUID, Int64), presenting(UUID)
    }
    private var state = State.idle

    mutating func select(_ id: UUID) -> Bool {
        guard case .idle = state else { return false }
        state = .authenticating(id)
        return true
    }

    mutating func authenticate(_ id: UUID, approved: Bool, now: Int64) -> Int64? {
        guard case .authenticating(let current) = state, current == id else { return nil }
        guard approved else { state = .idle; return nil }
        let expiresAt = now + 10_000
        state = .offered(id, expiresAt)
        return expiresAt
    }

    mutating func claim(_ id: UUID, now: Int64) -> Bool {
        guard case .offered(let current, let expiresAt) = state, current == id, now < expiresAt else { return false }
        state = .presenting(id)
        return true
    }

    mutating func retire(_ id: UUID) -> Bool {
        switch state {
        case .offered(let current, _), .presenting(let current):
            guard current == id else { return false }
            state = .idle
            return true
        default: return false
        }
    }
}

enum Refusal: String, Error, Codable {
    case invalidRequest, notAuthorized, targetChanged, staleRevision, stopped, unsupported, permissionMissing
    case sensitive, captcha, unverified, busy, unavailable, uncertain, confirmationRequired
}

typealias PreviewFence = @Sendable () throws -> Void

final class InteractionFence: @unchecked Sendable {
    private struct Grant {
        let id: UUID
        let target: InteractionTarget
        var expiry: ContinuousClock.Instant
        var active = false
        var revision: String?
        var captureGeneration = UUID()
    }

    private let lock = NSLock()
    private var grant: Grant?

    func begin(_ target: InteractionTarget) throws -> UUID {
        try lock.withLock {
            guard grant == nil else { throw Refusal.busy }
            let id = UUID()
            grant = Grant(id: id, target: target, expiry: .now.advanced(by: .seconds(60)))
            return id
        }
    }

    func activate(_ id: UUID, target: InteractionTarget, visible: Bool) throws {
        try lock.withLock {
            guard var candidate = grant, candidate.id == id, candidate.expiry > .now else { throw Refusal.stopped }
            guard candidate.target == target else { throw Refusal.targetChanged }
            guard visible, !candidate.active else { throw Refusal.notAuthorized }
            candidate.active = true
            candidate.expiry = .now.advanced(by: .seconds(900))
            grant = candidate
        }
    }

    private func verified(_ id: UUID, target: InteractionTarget, revision: String?) throws -> Grant {
        guard let candidate = grant, candidate.id == id, candidate.expiry > .now else { throw Refusal.stopped }
        guard candidate.target == target else { throw Refusal.targetChanged }
        guard candidate.active else { throw Refusal.notAuthorized }
        if let revision, candidate.revision != revision { throw Refusal.staleRevision }
        return candidate
    }

    func check(_ id: UUID, target: InteractionTarget, revision: String? = nil) throws {
        try lock.withLock { _ = try verified(id, target: target, revision: revision) }
    }

    func observed(_ id: UUID, target: InteractionTarget, revision: String) throws {
        try lock.withLock {
            var candidate = try verified(id, target: target, revision: nil)
            candidate.revision = revision
            grant = candidate
        }
    }

    func dispatch(_ id: UUID, target: InteractionTarget, revision: String) throws {
        try lock.withLock {
            var candidate = try verified(id, target: target, revision: revision)
            candidate.revision = nil
            candidate.captureGeneration = UUID()
            grant = candidate
        }
    }

    func capture<Frame: Sendable>(_ id: UUID, target: InteractionTarget, read: (PreviewFence) async throws -> Frame) async throws
        -> (frame: Frame, verify: PreviewFence) {
        let generation = try lock.withLock { try verified(id, target: target, revision: nil).captureGeneration }
        let verify: PreviewFence = { [self] in
            try lock.withLock {
                guard try verified(id, target: target, revision: nil).captureGeneration == generation else { throw Refusal.staleRevision }
            }
        }
        let frame = try await read(verify)
        try verify()
        return (frame, verify)
    }

    @discardableResult
    func stop(_ id: UUID? = nil) -> Bool {
        lock.withLock {
            guard let active = grant, id == nil || id == active.id else { return false }
            grant = nil
            return true
        }
    }
}

enum WindowSafety {
    static func allowedApp(_ bundleID: String) -> Bool {
        let id = bundleID.lowercased()
        let denied = ["com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.securityagent", "com.apple.loginwindow",
                      "com.1password", "com.bitwarden", "com.dashlane", "app.ycoding", "com.google.chrome", "org.chromium",
                      "com.apple.terminal", "com.googlecode.iterm2", "dev.warp", "com.mitchellh.ghostty", "net.kovidgoyal.kitty",
                      "org.alacritty", "com.github.wez.wezterm"]
        return !id.isEmpty && !denied.contains { id == $0 || id.hasPrefix($0 + ".") }
    }

    static func sensitive(role: String, description: String) -> Bool {
        let role = role.lowercased()
        let text = description.lowercased().replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        return role.contains("secure") || ["password", "passcode", "passkey", "credential", "captcha", "security code",
                                          "verification code", "one time", "two factor", "otp", "credit card", "card number",
                                          "api key", "secret key", "recovery code", "bank account", "payment"].contains { text.contains($0) }
    }

    static func canReplace(role: String, description: String, enabled: Bool, writable: Bool) -> Bool {
        let label = description.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return role == "AXTextField" && enabled && writable && !sensitive(role: role, description: description)
            && (label == "search" || label == "filter" || label == "find")
    }

    static func canPress(role: String, description: String, enabled: Bool, advertised: Bool) -> Bool {
        return enabled && advertised && ["AXButton", "AXCheckBox", "AXRadioButton", "AXDisclosureTriangle"].contains(role)
            && !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !sensitive(role: role, description: description)
    }
}
