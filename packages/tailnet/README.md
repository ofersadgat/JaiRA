# jaira-tailnet

JaiRA's own way onto a tailnet, for a machine without the Tailscale app (decision 0013 §2). A small Go
program built on Tailscale's embeddable library, `tsnet` (BSD-3-Clause). It joins the person's tailnet
as its own node after a one-time sign-in, and forwards to the engine's loopback listener.

It is not built by the Node workspace's `build`. Every installer carries the one for its platform:
`packages/app/buildTailnet.mjs` compiles it while the app is packaged, into `packages/app/dist/tailnet/`,
which the installer ships as `resources/tailnet` beside the built-in layer. It uses the `go` on the PATH,
or downloads the current Go release into the temporary directory when there is none.
`.github/workflows/tailnet.yml` checks that it compiles for all six platforms when it changes.

To use it in a development build:

```sh
npm --workspace @jaira/app run tailnet
```

Or point JaiRA at any build of it with `JAIRA_TAILNET_HELPER=/path/to/jaira-tailnet`. It is used when the
Tailscale app is not installed.
