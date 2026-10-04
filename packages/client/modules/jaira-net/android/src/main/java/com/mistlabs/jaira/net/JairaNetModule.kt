package com.mistlabs.jaira.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * The phone's network module (decision 0013, amended 2026-10-04), the JavaScript side of which is
 * `packages/client/bridges/nearby.native.ts`:
 *
 *  - JaiRA machines nearby: an NSD browse for `_jaira._tcp`, each one resolved for its address and TXT
 *    record, the whole list again on every change (`onNearby`).
 *  - Tailscale built in (`libs/tailnet.aar`, gomobile, packages/tailnet/mobile) — see `TailnetBridge`.
 */
class JairaNetModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var nsd: NsdManager? = null
  private var discovery: NsdManager.DiscoveryListener? = null
  private val found = LinkedHashMap<String, Map<String, Any>>()
  /** NSD resolves one service at a time: the rest wait their turn. */
  private val toResolve = ArrayDeque<NsdServiceInfo>()
  private var resolving = false
  /** Browsing is wanted: a browse that fails to start is tried again until `stopBrowsing`. */
  private var wanted = false
  private var retryMs = 1000L

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no React context" }

  override fun definition() = ModuleDefinition {
    Name("JairaNet")

    Events("onNearby", "onTailnetState")

    Function("tailnetAvailable") { TailnetBridge.available }

    Function("startBrowsing") {
      main.post {
        wanted = true
        retryMs = 1000L
        startBrowsing()
      }
    }

    Function("stopBrowsing") {
      main.post {
        wanted = false
        stopBrowsing()
      }
    }

    Function("localAddresses") { localAddresses() }

    AsyncFunction("tailnetStart") { hostname: String ->
      val dir = File(context.filesDir, "tailnet").apply { mkdirs() }
      TailnetBridge.start(dir.path, hostname) { state -> main.post { sendEvent("onTailnetState", mapOf("state" to state)) } }
    }

    AsyncFunction("tailnetProxy") { target: String -> TailnetBridge.proxy(target) }

    Function("tailnetState") { TailnetBridge.state() }

    AsyncFunction("tailnetLogout") { TailnetBridge.logout() }

    OnDestroy { main.post { stopBrowsing() } }
  }

  private fun publish(state: String, problem: String? = null) {
    val body = mutableMapOf<String, Any>("machines" to found.values.toList(), "state" to state)
    if (problem != null) body["problem"] = problem
    sendEvent("onNearby", body)
  }

  /** This phone's IPv4 addresses on its networks (Wi-Fi first): what a machine nearby sees it as. */
  private fun localAddresses(): List<String> =
    runCatching {
      NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
        .flatMap { i -> i.inetAddresses.toList().filterIsInstance<Inet4Address>().mapNotNull { it.hostAddress } }
        .filter { !it.startsWith("169.254.") }
    }.getOrDefault(emptyList())

  private fun startBrowsing() {
    stopBrowsing()
    val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    nsd = manager
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {
        main.post { publish("browsing") }
      }

      override fun onDiscoveryStopped(serviceType: String) {}

      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        main.post {
          val delay = retryMs
          retryMs = minOf(retryMs * 2, 30_000L)
          discovery = null
          publish("retrying", "could not look on this network (NSD error $errorCode) — looking again in ${delay / 1000} s")
          main.postDelayed({ if (wanted) startBrowsing() }, delay)
        }
      }

      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}

      override fun onServiceFound(service: NsdServiceInfo) {
        main.post {
          toResolve.addLast(service)
          resolveNext()
        }
      }

      override fun onServiceLost(service: NsdServiceInfo) {
        main.post {
          if (found.remove(service.serviceName) != null) publish("browsing")
        }
      }
    }
    discovery = listener
    publish("starting")
    manager.discoverServices("_jaira._tcp", NsdManager.PROTOCOL_DNS_SD, listener)
  }

  @Suppress("DEPRECATION")
  private fun resolveNext() {
    val manager = nsd ?: return
    if (resolving) return
    val service = toResolve.removeFirstOrNull() ?: return
    resolving = true
    manager.resolveService(
      service,
      object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
          main.post {
            resolving = false
            resolveNext()
          }
        }

        override fun onServiceResolved(info: NsdServiceInfo) {
          main.post {
            resolving = false
            val txt = info.attributes.mapValues { (_, value) -> value?.toString(Charsets.UTF_8) ?: "" }
            val host = info.host?.hostAddress
            found[info.serviceName] = buildMap {
              put("name", info.serviceName)
              put("txt", txt)
              put("port", info.port)
              if (host != null) put("host", host)
            }
            publish("browsing")
            resolveNext()
          }
        }
      },
    )
  }

  private fun stopBrowsing() {
    val listener = discovery
    discovery = null
    if (listener != null) runCatching { nsd?.stopServiceDiscovery(listener) }
    toResolve.clear()
    resolving = false
    found.clear()
  }
}
