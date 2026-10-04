package com.mistlabs.jaira.net

/** A build without `libs/tailnet.aar` (`build.mjs android` was not run): no tailnet, said as such. */
object TailnetBridge {
  const val available = false

  private fun none(): Nothing = throw IllegalStateException("this build of JaiRA has no Tailscale built in")

  fun start(dir: String, hostname: String, onState: (String) -> Unit): Unit = none()

  fun proxy(target: String): Int = none()

  fun state(): String = "{\"state\":\"unavailable\"}"

  fun logout() {}
}
