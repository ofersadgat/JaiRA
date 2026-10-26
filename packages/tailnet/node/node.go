// Package node is JaiRA's own node on a tailnet (decision 0022): Tailscale's embeddable library, tsnet,
// driven the way JaiRA needs it on a desktop (the jaira-tailnet helper, ../main.go) and on a phone
// (../mobile). It signs in and out, says who it is and which devices share the tailnet, publishes the
// engine's loopback listener, and opens local doors to other devices.
//
// Everything it has to say is an event: one JSON object, handed to the Say function given to New.
//
//	{"state":"needs-login","url":"https://login.tailscale.com/a/…"}   sign in on this page
//	{"state":"dropped"}                                              it was running, and Tailscale signed it out
//	{"state":"running","self":{…},"user":{…},"tailnet":"…","url":"…"}
//	{"devices":[{"id","name","dnsName","os","online","lastSeen","ips"}, …]}
//	{"state":"error","message":"…"}
package node

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

// Say hears one event.
type Say func(event map[string]any)

// Node is one tsnet node and what it serves.
type Node struct {
	srv     *tsnet.Server
	say     Say
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	lc      *local.Client
	state   ipn.State
	lastURL string
	target  string
	url     string
	serving bool
	doors   map[string]string
	pending *time.Timer
}

// New makes a node that keeps its identity in dir and is called hostname on the tailnet.
func New(dir, hostname string, say Say) *Node {
	ctx, cancel := context.WithCancel(context.Background())
	return &Node{
		srv:    &tsnet.Server{Dir: dir, Hostname: hostname, Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {}},
		say:    say,
		ctx:    ctx,
		cancel: cancel,
		doors:  map[string]string{},
	}
}

// Start brings the node up. With no identity yet, or one signed out, it asks for a sign-in: the page
// arrives as a needs-login event.
func (n *Node) Start() error {
	if err := n.srv.Start(); err != nil {
		return err
	}
	lc, err := n.srv.LocalClient()
	if err != nil {
		return err
	}
	n.mu.Lock()
	n.lc = lc
	n.mu.Unlock()
	watcher, err := lc.WatchIPNBus(n.ctx, ipn.NotifyInitialState|ipn.NotifyInitialNetMap|ipn.NotifyRateLimit)
	if err != nil {
		return err
	}
	go n.watch(watcher)
	return nil
}

func (n *Node) watch(watcher *local.IPNBusWatcher) {
	defer watcher.Close()
	for {
		note, err := watcher.Next()
		if err != nil {
			if n.ctx.Err() == nil {
				n.say(map[string]any{"state": "error", "message": err.Error()})
			}
			return
		}
		if note.ErrMessage != nil && *note.ErrMessage != "" {
			n.say(map[string]any{"state": "error", "message": *note.ErrMessage})
		}
		if note.BrowseToURL != nil && *note.BrowseToURL != "" {
			n.mu.Lock()
			fresh := *note.BrowseToURL != n.lastURL
			n.lastURL = *note.BrowseToURL
			n.mu.Unlock()
			if fresh {
				n.say(map[string]any{"state": "needs-login", "url": *note.BrowseToURL})
			}
		}
		if note.State != nil {
			n.mu.Lock()
			was := n.state
			n.state = *note.State
			n.mu.Unlock()
			switch *note.State {
			case ipn.Running:
				if was != ipn.Running {
					n.publish()
					n.sayRunning()
					n.sayDevices()
				}
			case ipn.NeedsLogin, ipn.NeedsMachineAuth:
				// Only a node that was running is dropped: one starting signed out is waiting for
				// its sign-in page, which comes as BrowseToURL.
				if was == ipn.Running {
					n.mu.Lock()
					n.lastURL = ""
					n.mu.Unlock()
					n.say(map[string]any{"state": "dropped"})
				}
			}
		}
		if note.NetMap != nil {
			n.devicesSoon()
		}
	}
}

func (n *Node) status() (*ipnstate.Status, error) {
	n.mu.Lock()
	lc := n.lc
	n.mu.Unlock()
	if lc == nil {
		return nil, errors.New("not started")
	}
	ctx, cancel := context.WithTimeout(n.ctx, 10*time.Second)
	defer cancel()
	return lc.Status(ctx)
}

func (n *Node) sayRunning() {
	status, err := n.status()
	if err != nil || status.Self == nil {
		return
	}
	self := status.Self
	event := map[string]any{
		"state": "running",
		"self":  map[string]any{"id": string(self.ID), "name": self.HostName, "dnsName": strings.TrimSuffix(self.DNSName, "."), "ips": ipsOf(self)},
	}
	if user, ok := status.User[self.UserID]; ok {
		event["user"] = map[string]any{"login": user.LoginName, "name": user.DisplayName}
	}
	if status.CurrentTailnet != nil {
		event["tailnet"] = status.CurrentTailnet.MagicDNSSuffix
	}
	n.mu.Lock()
	if n.url != "" {
		event["url"] = n.url
	}
	n.mu.Unlock()
	n.say(event)
}

// devicesSoon says the devices once a burst of network-map changes has settled.
func (n *Node) devicesSoon() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.pending != nil {
		n.pending.Stop()
	}
	n.pending = time.AfterFunc(400*time.Millisecond, n.sayDevices)
}

// Devices says the devices on the tailnet now.
func (n *Node) Devices() { n.sayDevices() }

func (n *Node) sayDevices() {
	status, err := n.status()
	if err != nil || status.BackendState != ipn.Running.String() {
		return
	}
	devices := []map[string]any{}
	for _, peer := range status.Peer {
		device := map[string]any{
			"id":      string(peer.ID),
			"name":    peer.HostName,
			"dnsName": strings.TrimSuffix(peer.DNSName, "."),
			"os":      peer.OS,
			"online":  peer.Online,
			"ips":     ipsOf(peer),
		}
		if !peer.LastSeen.IsZero() {
			device["lastSeen"] = peer.LastSeen.UnixMilli()
		}
		devices = append(devices, device)
	}
	n.say(map[string]any{"devices": devices})
}

func ipsOf(peer *ipnstate.PeerStatus) []string {
	ips := []string{}
	for _, ip := range peer.TailscaleIPs {
		ips = append(ips, ip.String())
	}
	return ips
}

// Login asks for a sign-in page (a needs-login event with its url).
func (n *Node) Login() error {
	n.mu.Lock()
	lc := n.lc
	n.lastURL = ""
	n.mu.Unlock()
	if lc == nil {
		return errors.New("not started")
	}
	return lc.StartLoginInteractive(n.ctx)
}

// Logout signs the node out. Its identity stays in its directory: signing in again, as anyone, is the
// same device on the tailnet.
func (n *Node) Logout() error {
	n.mu.Lock()
	lc := n.lc
	n.mu.Unlock()
	if lc == nil {
		return errors.New("not started")
	}
	ctx, cancel := context.WithTimeout(n.ctx, 20*time.Second)
	defer cancel()
	return lc.Logout(ctx)
}

// Serve publishes target (a loopback host:port) on the tailnet once the node is running: HTTPS on 443
// when the tailnet has certificates, plain HTTP on 80 otherwise, which WireGuard already encrypts.
func (n *Node) Serve(target string) error {
	if host, _, err := net.SplitHostPort(target); err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		return errors.New("the target must be a loopback address")
	}
	n.mu.Lock()
	n.target = target
	running := n.state == ipn.Running
	n.mu.Unlock()
	if running {
		n.publish()
		n.sayRunning()
	}
	return nil
}

func (n *Node) publish() {
	n.mu.Lock()
	target, serving := n.target, n.serving
	n.mu.Unlock()
	if target == "" || serving {
		return
	}
	status, err := n.status()
	if err != nil || status.Self == nil {
		return
	}
	dnsName := strings.TrimSuffix(status.Self.DNSName, ".")
	proxy := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: target})
	proxy.FlushInterval = -1
	scheme := "https"
	listener, err := n.srv.ListenTLS("tcp", ":443")
	if err != nil {
		scheme = "http"
		listener, err = n.srv.Listen("tcp", ":80")
		if err != nil {
			n.say(map[string]any{"state": "error", "message": err.Error()})
			return
		}
	}
	n.mu.Lock()
	n.serving = true
	n.url = scheme + "://" + dnsName
	n.mu.Unlock()
	go func() {
		<-n.ctx.Done()
		listener.Close()
	}()
	go func() {
		if err := http.Serve(listener, proxy); err != nil && n.ctx.Err() == nil {
			n.say(map[string]any{"state": "error", "message": err.Error()})
		}
	}()
}

// Door answers a loopback address that forwards HTTP, WebSockets included, to address (a device's
// http:// or https:// URL) over the tailnet, TLS and all. One door per address, kept while the node
// runs.
func (n *Node) Door(address string) (string, error) {
	target, err := url.Parse(address)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		return "", fmt.Errorf("%q is not an http(s) address", address)
	}
	key := target.Scheme + "://" + target.Host
	n.mu.Lock()
	if local, ok := n.doors[key]; ok {
		n.mu.Unlock()
		return local, nil
	}
	n.mu.Unlock()
	base := &url.URL{Scheme: target.Scheme, Host: target.Host}
	hostname := target.Hostname()
	transport := &http.Transport{
		DialContext:         n.srv.Dial,
		TLSClientConfig:     &tls.Config{ServerName: hostname},
		ForceAttemptHTTP2:   false,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 15 * time.Second,
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(base)
			r.Out.Host = base.Host
		},
		Transport:     transport,
		FlushInterval: -1,
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	local := listener.Addr().String()
	n.mu.Lock()
	n.doors[key] = local
	n.mu.Unlock()
	go func() {
		<-n.ctx.Done()
		listener.Close()
	}()
	go http.Serve(listener, proxy)
	return local, nil
}

// Close takes the node off the tailnet (it stays signed in) and closes its doors.
func (n *Node) Close() {
	n.cancel()
	n.srv.Close()
}
