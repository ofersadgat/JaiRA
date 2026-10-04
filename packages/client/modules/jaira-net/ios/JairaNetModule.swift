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
 *    list again on every change (`onNearby`). The system asks for local-network access the first time.
 *  - Tailscale built in (`Tailnet.xcframework`, gomobile, packages/tailnet/mobile): start the node, hear
 *    its state (`onTailnetState`), and a loopback port proxying to an engine on the tailnet.
 */
public class JairaNetModule: Module {
  private var browser: NWBrowser?

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
      DispatchQueue.main.async { self.startBrowsing() }
    }

    Function("stopBrowsing") {
      DispatchQueue.main.async {
        self.browser?.cancel()
        self.browser = nil
      }
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
      self.browser?.cancel()
      self.browser = nil
    }
  }

  private func startBrowsing() {
    browser?.cancel()
    let parameters = NWParameters()
    parameters.includePeerToPeer = false
    let next = NWBrowser(for: .bonjourWithTXTRecord(type: "_jaira._tcp", domain: nil), using: parameters)
    next.browseResultsChangedHandler = { [weak self] results, _ in
      let machines: [[String: Any]] = results.compactMap { result in
        guard case let .service(name, _, _, _) = result.endpoint else { return nil }
        var txt: [String: String] = [:]
        if case let .bonjour(record) = result.metadata { txt = record.dictionary }
        return ["name": name, "txt": txt]
      }
      self?.sendEvent("onNearby", ["machines": machines])
    }
    next.stateUpdateHandler = { [weak self] state in
      switch state {
      case let .waiting(error), let .failed(error):
        // -65570 (kDNSServiceErr_PolicyDenied): local-network access was refused in Settings.
        let denied: Bool
        if case let .dns(code) = error { denied = code == -65570 } else { denied = false }
        self?.sendEvent("onNearby", ["machines": [], "problem": denied ? "denied" : error.localizedDescription])
      default:
        break
      }
    }
    next.start(queue: .main)
    browser = next
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

private final class NoTailnetException: Exception {
  override var reason: String {
    "this build of JaiRA has no Tailscale built in"
  }
}
