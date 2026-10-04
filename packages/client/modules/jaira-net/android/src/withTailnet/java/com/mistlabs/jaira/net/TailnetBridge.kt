package com.mistlabs.jaira.net

import com.mistlabs.jaira.tailnet.InterfaceSource
import com.mistlabs.jaira.tailnet.StateListener
import com.mistlabs.jaira.tailnet.Tailnet
import java.net.NetworkInterface

/** Tailscale built in: the gomobile library from packages/tailnet/mobile (`libs/maven`). */
object TailnetBridge {
  const val available = true

  /**
   * The phone's interfaces, as the node asks for them: Android 11 and later refuse Go's own way of
   * listing them, and the node would not start (packages/tailnet/mobile/interfaces.go).
   */
  private val interfaces = object : InterfaceSource {
    override fun interfaces(): String =
      runCatching {
        NetworkInterface.getNetworkInterfaces().toList().joinToString("\n") { i ->
          val addresses = i.interfaceAddresses.joinToString(" ") { "${it.address.hostAddress?.substringBefore('%')}/${it.networkPrefixLength}" }
          "${i.name} ${i.index} ${i.mtu} ${i.isUp} ${i.supportsMulticast()} ${i.isLoopback} ${i.isPointToPoint} ${i.supportsMulticast()} | $addresses"
        }
      }.getOrDefault("")
  }

  fun start(dir: String, hostname: String, relay: (String) -> Unit) {
    Tailnet.useInterfaces(interfaces)
    Tailnet.start(dir, hostname, object : StateListener {
      override fun onState(state: String?) {
        if (state != null) relay(state)
      }
    })
  }

  fun proxy(target: String): Int = Tailnet.proxy(target).toInt()

  fun state(): String = Tailnet.state()

  fun logout() = Tailnet.logout()
}
