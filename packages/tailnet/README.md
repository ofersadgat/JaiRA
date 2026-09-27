# jaira-tailnet

JaiRA's own way onto a tailnet, for a machine without the Tailscale app (decision 0013 §2). A small Go
program built on Tailscale's embeddable library, `tsnet` (BSD-3-Clause). It joins the person's tailnet
as its own node after a one-time sign-in, and forwards to the engine's loopback listener.

It is not built by the Node workspace. CI builds one binary per platform (`.github/workflows/tailnet.yml`)
into the per-platform npm packages the Tailscale plugin downloads (decision 0011 §6). `go.sum` is written
by the first `go mod tidy`, which needs Go and the network.

To try it from a checkout with Go installed:

```sh
cd packages/tailnet
go mod tidy
go build -o jaira-tailnet .
```

Then point JaiRA at it with `JAIRA_TAILNET_HELPER=/path/to/jaira-tailnet`. It is used when the Tailscale
app is not installed.
