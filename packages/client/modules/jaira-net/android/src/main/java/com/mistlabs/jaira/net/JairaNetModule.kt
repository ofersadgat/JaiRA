package com.mistlabs.jaira.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

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

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no React context" }

  override fun definition() = ModuleDefinition {
    Name("JairaNet")

    Events("onNearby", "onTailnetState")

    Function("tailnetAvailable") { TailnetBridge.available }

    Function("startBrowsing") { main.post { startBrowsing() } }

    Function("stopBrowsing") { main.post { stopBrowsing() } }

    AsyncFunction("tailnetStart") { hostname: String ->
      val dir = File(context.filesDir, "tailnet").apply { mkdirs() }
      TailnetBridge.start(dir.path, hostname) { state -> main.post { sendEvent("onTailnetState", mapOf("state" to state)) } }
    }

    AsyncFunction("tailnetProxy") { target: String -> TailnetBridge.proxy(target) }

    Function("tailnetState") { TailnetBridge.state() }

    AsyncFunction("tailnetLogout") { TailnetBridge.logout() }

    OnDestroy { main.post { stopBrowsing() } }
  }

  private fun publish(problem: String? = null) {
    val machines = found.values.toList()
    sendEvent("onNearby", if (problem == null) mapOf("machines" to machines) else mapOf("machines" to machines, "problem" to problem))
  }

  private fun startBrowsing() {
    stopBrowsing()
    val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    nsd = manager
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {}

      override fun onDiscoveryStopped(serviceType: String) {}

      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        main.post { publish("could not look for machines on this network (error $errorCode)") }
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
          if (found.remove(service.serviceName) != null) publish()
        }
      }
    }
    discovery = listener
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
            publish()
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
