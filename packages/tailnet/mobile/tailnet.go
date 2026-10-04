// Package tailnet is the phone app's own way onto the person's tailnet (decision 0013, amended
// 2026-10-04): Tailscale's embeddable library (tsnet) inside the app, so the phone needs no Tailscale
// app. It is the desktop helper's twin (../main.go), bound for iOS and Android with gomobile:
//
//	gomobile bind -target=ios,iossimulator -o Tailnet.xcframework ./mobile
//	gomobile bind -target=android -javapkg=com.mistlabs.jaira -o tailnet.aar ./mobile
//
// The node runs in the app's process, in userspace: no VPN profile, nothing for the rest of the phone.
// It is up while the app is; the system suspends both together, and it picks up where it was when the
// app comes back (its state is kept in the directory given to Start).
//
// The app's JavaScript cannot dial through it, so Proxy gives it a loopback port instead: an HTTP and
// WebSocket proxy to one engine on the tailnet, dialled through the node. The app connects to
// ws://127.0.0.1:<port>/engine exactly as it would to the engine, and TLS is done here, against the
// engine's own name and certificate.
package tailnet

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

// StateListener hears the node's state, one JSON object per change, in the helper's words:
//
//	{"state":"starting"}
//	{"state":"needs-login","url":"https://login.tailscale.com/a/…"}
//	{"state":"running","dnsName":"jaira-pixel.tail4c2e.ts.net"}
//	{"state":"error","message":"…"}
type StateListener interface {
	OnState(state string)
}

var (
	mu       sync.Mutex
	server   *tsnet.Server
	cancel   context.CancelFunc
	listener StateListener
	current  = `{"state":"stopped"}`
	lastLink string
	proxies  = map[string]*proxy{}
)

type proxy struct {
	port     int
	listener net.Listener
}

func say(fields map[string]any) {
	line, _ := json.Marshal(fields)
	mu.Lock()
	current = string(line)
	l := listener
	mu.Unlock()
	if l != nil {
		l.OnState(string(line))
	}
}

// State is the last state said, as OnState said it.
func State() string {
	mu.Lock()
	defer mu.Unlock()
	return current
}

// Start the node, keeping its state in dir, named hostname on the tailnet. Starting again only
// replaces the listener and says the state again. It returns at once; the state follows.
func Start(dir, hostname string, l StateListener) error {
	mu.Lock()
	listener = l
	if server != nil {
		state := current
		mu.Unlock()
		if l != nil {
			l.OnState(state)
		}
		return nil
	}
	if dir == "" {
		mu.Unlock()
		return errors.New("a directory for the node's state is needed")
	}
	// Where Tailscale keeps its log state: on Android it finds no place of its own and panics ("no safe
	// place found to store log state"), taking the app with it. And none of it is uploaded: a window has
	// nothing for Tailscale's support to read.
	_ = os.Setenv("TS_LOGS_DIR", dir)
	_ = os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	s := &tsnet.Server{Dir: dir, Hostname: hostname, Logf: func(string, ...any) {}}
	// The sign-in link is said in the library's user log, again every few seconds while nobody has signed
	// in; the IPN bus says it too (below). Either way it is passed on once per link.
	s.UserLogf = func(format string, args ...any) {
		line := fmt.Sprintf(format, args...)
		if at := strings.Index(line, "https://login.tailscale.com/"); at >= 0 {
			needsLogin(strings.Fields(line[at:])[0])
		}
	}
	ctx, stop := context.WithCancel(context.Background())
	server, cancel, lastLink = s, stop, ""
	mu.Unlock()

	say(map[string]any{"state": "starting"})
	go run(ctx, s)
	return nil
}

func needsLogin(link string) {
	mu.Lock()
	same := link == lastLink
	lastLink = link
	mu.Unlock()
	if !same {
		say(map[string]any{"state": "needs-login", "url": link})
	}
}

func run(ctx context.Context, s *tsnet.Server) {
	if err := s.Start(); err != nil {
		say(map[string]any{"state": "error", "message": err.Error()})
		return
	}
	local, err := s.LocalClient()
	if err != nil {
		say(map[string]any{"state": "error", "message": err.Error()})
		return
	}
	for ctx.Err() == nil {
		watcher, err := local.WatchIPNBus(ctx, ipn.NotifyInitialState)
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		for {
			n, err := watcher.Next()
			if err != nil {
				break
			}
			if n.BrowseToURL != nil && *n.BrowseToURL != "" {
				needsLogin(*n.BrowseToURL)
			}
			if n.State == nil {
				continue
			}
			switch *n.State {
			case ipn.Running:
				status, err := local.StatusWithoutPeers(ctx)
				dnsName := ""
				if err == nil && status.Self != nil {
					dnsName = strings.TrimSuffix(status.Self.DNSName, ".")
				}
				mu.Lock()
				lastLink = ""
				mu.Unlock()
				say(map[string]any{"state": "running", "dnsName": dnsName})
			case ipn.NeedsLogin:
				// Signed out, or the node's key expired: ask for a new sign-in page.
				go func() { _ = local.StartLoginInteractive(ctx) }()
			}
		}
		watcher.Close()
	}
}

// Proxy gives a loopback port that forwards HTTP and WebSocket requests to target — an engine's
// address on the tailnet, "https://desk.tail4c2e.ts.net" or "http://jaira-desk.tail4c2e.ts.net" — dialled
// through the node. The same target gets the same port while the app runs.
func Proxy(target string) (int, error) {
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return 0, fmt.Errorf("'%s' is not an engine's address on the tailnet", target)
	}
	mu.Lock()
	defer mu.Unlock()
	if server == nil {
		return 0, errors.New("the tailnet is not started")
	}
	key := u.Scheme + "://" + u.Host
	if p, ok := proxies[key]; ok {
		return p.port, nil
	}
	s := server
	transport := &http.Transport{
		DialContext:         func(ctx context.Context, network, address string) (net.Conn, error) { return s.Dial(ctx, network, address) },
		TLSClientConfig:     &tls.Config{ServerName: u.Hostname()},
		TLSHandshakeTimeout: 15 * time.Second,
		IdleConnTimeout:     60 * time.Second,
	}
	handler := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(&url.URL{Scheme: u.Scheme, Host: u.Host})
			r.Out.Host = u.Host
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, "the tailnet did not reach "+u.Host+": "+err.Error(), http.StatusBadGateway)
		},
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	proxies[key] = &proxy{port: port, listener: l}
	go func() { _ = http.Serve(l, handler) }()
	return port, nil
}

// Logout signs the node out of the tailnet; the next Start asks for a sign-in again.
func Logout() error {
	mu.Lock()
	s := server
	mu.Unlock()
	if s == nil {
		return nil
	}
	local, err := s.LocalClient()
	if err != nil {
		return err
	}
	ctx, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	return local.Logout(ctx)
}

// Stop the node and every proxy.
func Stop() {
	mu.Lock()
	s, stop := server, cancel
	server, cancel = nil, nil
	for key, p := range proxies {
		p.listener.Close()
		delete(proxies, key)
	}
	mu.Unlock()
	if stop != nil {
		stop()
	}
	if s != nil {
		s.Close()
	}
	say(map[string]any{"state": "stopped"})
}
