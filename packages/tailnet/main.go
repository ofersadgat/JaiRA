// jaira-tailnet: JaiRA's own way onto a tailnet, for a machine without the Tailscale app (decision 0013
// §2, ruled 2026-09-27: "Both now"). It joins the person's tailnet as its own node with Tailscale's
// embeddable library (tsnet) and forwards what arrives to the engine's loopback listener, so the other
// machines reach this one exactly as through `tailscale serve`.
//
//	jaira-tailnet --dir <state dir> --hostname jaira-desk --target 127.0.0.1:47318
//
// It says what it is doing as one JSON object per line on stdout, which JaiRA reads:
//
//	{"state":"needs-login","url":"https://login.tailscale.com/a/…"}   the one-time sign-in, to open
//	{"state":"running","url":"https://jaira-desk.tail4c2e.ts.net","dnsName":"jaira-desk.tail4c2e.ts.net"}
//	{"state":"error","message":"…"}
//
// HTTPS when the tailnet has certificates turned on; plain HTTP on the tailnet otherwise, which WireGuard
// already encrypts. Nothing is exposed outside the tailnet (no Funnel).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"tailscale.com/tsnet"
)

func say(fields map[string]any) {
	line, _ := json.Marshal(fields)
	fmt.Println(string(line))
}

func fail(message string) {
	say(map[string]any{"state": "error", "message": message})
	os.Exit(1)
}

func main() {
	dir := flag.String("dir", "", "where the node keeps its state (its identity on the tailnet)")
	hostname := flag.String("hostname", "jaira", "the node's name on the tailnet")
	target := flag.String("target", "", "the engine's loopback listener, host:port")
	flag.Parse()
	if *dir == "" || *target == "" {
		fail("--dir and --target are required")
	}
	if host, _, err := net.SplitHostPort(*target); err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		fail("--target must be a loopback address")
	}

	server := &tsnet.Server{Dir: *dir, Hostname: *hostname, Logf: func(string, ...any) {}}
	// The sign-in link is only ever said in the library's user log.
	server.UserLogf = func(format string, args ...any) {
		line := fmt.Sprintf(format, args...)
		if at := strings.Index(line, "https://login.tailscale.com/"); at >= 0 {
			say(map[string]any{"state": "needs-login", "url": strings.Fields(line[at:])[0]})
		}
	}
	defer server.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	status, err := server.Up(ctx)
	if err != nil {
		fail(err.Error())
	}
	dnsName := strings.TrimSuffix(status.Self.DNSName, ".")

	proxy := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: *target})
	scheme := "https"
	listener, err := server.ListenTLS("tcp", ":443")
	if err != nil {
		scheme = "http"
		listener, err = server.Listen("tcp", ":80")
		if err != nil {
			fail(err.Error())
		}
	}
	say(map[string]any{"state": "running", "url": scheme + "://" + dnsName, "dnsName": dnsName})
	go func() {
		<-ctx.Done()
		listener.Close()
	}()
	if err := http.Serve(listener, proxy); err != nil && ctx.Err() == nil {
		fail(err.Error())
	}
}
