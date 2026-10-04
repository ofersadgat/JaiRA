package com.mistlabs.jaira.net

import com.mistlabs.jaira.tailnet.StateListener
import com.mistlabs.jaira.tailnet.Tailnet

/** Tailscale built in: the gomobile library from packages/tailnet/mobile (`libs/tailnet.aar`). */
object TailnetBridge {
  const val available = true

  fun start(dir: String, hostname: String, relay: (String) -> Unit) {
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
