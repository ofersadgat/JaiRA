import Darwin
import ExpoModulesCore
import Foundation
import Network
#if canImport(Tailnet)
import Tailnet
#endif

/**
 * The phone's network module (decision 0013, amended 2026-10-04), the JavaScript side of which is
 * `packages/client/bridges/nearby.native.ts`:
 *
 *  - JaiRA machines nearby: a Bonjour browse for `_jaira._tcp`, each one's name and TXT record, the whole
 *    list again on every change, with where the browse stands (`onNearby`). The system asks for
 *    local-network access the first time. A browse that fails — the system's Bonjour connection goes
 *    defunct (-65569) when the app goes inactive, as it does behind that very prompt — is started again
 *    by itself, waiting a little longer each time, until it is stopped.
 *  - Tailscale built in (`Tailnet.xcframework`, gomobile, packages/tailnet/mobile): start the node, hear
 *    its state (`onTailnetState`), and a loopback port proxying to an engine on the tailnet.
 */
public class JairaNetModule: Module {
  private var browser: NWBrowser?
  /** Browsing is wanted: a failed browse is started again until `stopBrowsing`. */
  private var wanted = false
  private var retryDelay: TimeInterval = 1
  private var retry: DispatchWorkItem?
  private var found: [[String: Any]] = []

  public func definition() -> ModuleDefinition {
    Name("JairaNet")

    Events("onNearby", "onTailnetState")

    Function("tailnetAvailable") { () -> Bool in
      #if canImport(Tailnet)
      return true
      #else
      return false
      #endif
    }

    Function("startBrowsing") {
      DispatchQueue.main.async {
        self.wanted = true
        self.retryDelay = 1
        self.startBrowsing()
      }
    }

    Function("stopBrowsing") {
      DispatchQueue.main.async { self.stopBrowsing() }
    }

    /** This phone's IPv4 addresses on its networks (Wi-Fi first): what a machine nearby sees it as. */
    Function("localAddresses") { () -> [String] in
      Self.localAddresses()
    }

    AsyncFunction("tailnetStart") { (hostname: String) in
      #if canImport(Tailnet)
      let dir = try Self.tailnetDirectory()
      var error: NSError?
      _ = TailnetStart(dir, hostname, StateRelay(module: self), &error)
      if let error { throw error }
      #else
      throw NoTailnetException()
      #endif
    }

    AsyncFunction("tailnetProxy") { (target: String) -> Int in
      #if canImport(Tailnet)
      var port = 0
      var error: NSError?
      _ = TailnetProxy(target, &port, &error)
      if let error { throw error }
      return port
      #else
      throw NoTailnetException()
      #endif
    }

    Function("tailnetState") { () -> String in
      #if canImport(Tailnet)
      return TailnetState()
      #else
      return "{\"state\":\"unavailable\"}"
      #endif
    }

    AsyncFunction("tailnetLogout") {
      #if canImport(Tailnet)
      var error: NSError?
      _ = TailnetLogout(&error)
      if let error { throw error }
      #endif
    }

    OnDestroy {
      self.stopBrowsing()
    }
  }

  private func say(_ state: String, problem: String? = nil) {
    var body: [String: Any] = ["machines": found, "state": state]
    if let problem { body["problem"] = problem }
    sendEvent("onNearby", body)
  }

  private func stopBrowsing() {
    wanted = false
    retry?.cancel()
    retry = nil
    browser?.cancel()
    browser = nil
    found = []
  }

  private func startBrowsing() {
    retry?.cancel()
    retry = nil
    browser?.cancel()
    let parameters = NWParameters()
    parameters.includePeerToPeer = false
    let next = NWBrowser(for: .bonjourWithTXTRecord(type: "_jaira._tcp", domain: nil), using: parameters)
    next.browseResultsChangedHandler = { [weak self] results, _ in
      guard let self, self.browser === next else { return }
      self.found = results.compactMap { result in
        guard case let .service(name, _, _, _) = result.endpoint else { return nil }
        var txt: [String: String] = [:]
        if case let .bonjour(record) = result.metadata { txt = record.dictionary }
        return ["name": name, "txt": txt]
      }
      self.say("browsing")
    }
    next.stateUpdateHandler = { [weak self] state in
      guard let self, self.browser === next else { return }
      switch state {
      case .ready:
        self.retryDelay = 1
        self.say("browsing")
      case let .waiting(error):
        // -65570 (kDNSServiceErr_PolicyDenied): local-network access was refused in Settings.
        if case let .dns(code) = error, code == -65570 {
          self.say("denied", problem: "denied")
        } else {
          self.say("waiting", problem: Self.describe(error))
        }
      case let .failed(error):
        // Dead for good: a new browse, a little later each time.
        next.cancel()
        self.browser = nil
        let delay = self.retryDelay
        self.retryDelay = min(self.retryDelay * 2, 30)
        self.say("retrying", problem: "\(Self.describe(error)) — looking again in \(Int(delay)) s")
        let work = DispatchWorkItem { [weak self] in
          guard let self, self.wanted else { return }
          self.startBrowsing()
        }
        self.retry = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
      default:
        break
      }
    }
    next.start(queue: .main)
    browser = next
    say("starting")
  }

  private static func describe(_ error: NWError) -> String {
    if case let .dns(code) = error {
      switch code {
      case -65569: return "the phone's Bonjour connection was dropped (-65569)"
      case -65570: return "local-network access is off for JaiRA"
      default: return "Bonjour error \(code)"
      }
    }
    return error.localizedDescription
  }

  private static func localAddresses() -> [String] {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return [] }
    defer { freeifaddrs(head) }
    var wifi: [String] = []
    var other: [String] = []
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let entry = cursor {
      defer { cursor = entry.pointee.ifa_next }
      let flags = Int32(entry.pointee.ifa_flags)
      guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
            flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
      let text = String(cString: host)
      if String(cString: entry.pointee.ifa_name) == "en0" { wifi.append(text) } else if !text.hasPrefix("169.254.") { other.append(text) }
    }
    return wifi + other
  }

  /** Where the node keeps its identity: Application Support, kept across launches and updates, not shared. */
  private static func tailnetDirectory() throws -> String {
    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let dir = support.appendingPathComponent("tailnet", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var url = dir
    try? url.setResourceValues(values)
    return dir.path
  }
}

#if canImport(Tailnet)
/** The node's state, from Go, to JavaScript. */
private final class StateRelay: NSObject, TailnetStateListenerProtocol {
  private weak var module: JairaNetModule?

  init(module: JairaNetModule) {
    self.module = module
  }

  func onState(_ state: String?) {
    guard let state else { return }
    DispatchQueue.main.async { [weak module] in
      module?.sendEvent("onTailnetState", ["state": state])
    }
  }
}
#endif

private final class NoTailnetException: Exception, @unchecked Sendable {
  override var reason: String {
    "this build of JaiRA has no Tailscale built in"
  }
}
