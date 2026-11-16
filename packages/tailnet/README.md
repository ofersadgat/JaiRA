# jaira-tailnet

JaiRA's own way onto a tailnet, for a machine without the Tailscale app (decision 0013 §2). A small Go
program built on Tailscale's embeddable library, `tsnet` (BSD-3-Clause). It joins the person's tailnet
as its own node after a one-time sign-in, and forwards to the engine's loopback listener.

Every installer carries the one for its platform: `packages/app/buildTailnet.mjs` compiles it while the
app is packaged, into `packages/app/dist/tailnet/`, which the installer ships as `resources/tailnet` beside
the built-in layer. It uses the `go` on the PATH, or downloads the current Go release into the temporary
directory when there is none. `.github/workflows/tailnet.yml` checks that it compiles for all six platforms
when it changes.

A development build has it too: the app's build (`build:main`) runs `buildTailnet.mjs --if-stale`, which
builds it when `dist/tailnet/` has none or one older than this package's sources (the `mobile/` package
and the tests aside). A failure there is said and the build goes on without it; under CI it is left to
the packaging. To build it by hand:

```sh
npm --workspace @jaira/app run tailnet
```

Or point JaiRA at any build of it with `JAIRA_TAILNET_HELPER=/path/to/jaira-tailnet`. It is used when the
Tailscale app is not installed.
