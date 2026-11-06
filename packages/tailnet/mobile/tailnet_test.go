package tailnet

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"tailscale.com/tsnet"
)

type states chan string

func (s states) OnState(state string) { s <- state }

// A fresh node asks for a sign-in, through the real control plane: opt-in, since it needs the internet.
//
//	JAIRA_TAILNET_LIVE=1 go test ./mobile
func TestFreshNodeAsksForSignIn(t *testing.T) {
	if os.Getenv("JAIRA_TAILNET_LIVE") != "1" {
		t.Skip("set JAIRA_TAILNET_LIVE=1 to reach Tailscale's control plane")
	}
	heard := make(states, 16)
	if err := Start(t.TempDir(), "jaira-test-phone", heard); err != nil {
		t.Fatal(err)
	}
	defer Stop()
	deadline := time.After(60 * time.Second)
	for {
		select {
		case state := <-heard:
			var s struct{ State, URL string }
			_ = json.Unmarshal([]byte(state), &s)
			t.Log(state)
			if s.State == "error" {
				t.Fatal(state)
			}
			if s.State == "needs-login" {
				if !strings.HasPrefix(s.URL, "https://login.tailscale.com/a/") {
					t.Fatalf("not a sign-in page: %s", s.URL)
				}
				return
			}
		case <-deadline:
			t.Fatalf("no sign-in page within a minute; last state %s", State())
		}
	}
}

// A node that was never started: Proxy only keeps it to dial through, which these tests never do.
func withIdleNode(t *testing.T) {
	t.Helper()
	mu.Lock()
	server = &tsnet.Server{}
	mu.Unlock()
	t.Cleanup(func() {
		CloseProxies()
		mu.Lock()
		server = nil
		mu.Unlock()
	})
}

func answers(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func TestProxyKeepsAPortWhileItAnswers(t *testing.T) {
	withIdleNode(t)
	first, err := Proxy("http://jaira-desk.tail4c2e.ts.net")
	if err != nil {
		t.Fatal(err)
	}
	again, err := Proxy("http://jaira-desk.tail4c2e.ts.net")
	if err != nil || again != first {
		t.Fatalf("asked again: %d, %v; first %d", again, err, first)
	}
}

// What the phone met after a night in the background (2026-11-06): the system took the port back, and
// the same dead port was handed out at every attempt until the app was restarted.
func TestProxyReplacesAPortTakenBack(t *testing.T) {
	withIdleNode(t)
	first, err := Proxy("http://jaira-desk.tail4c2e.ts.net")
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	p := proxies["http://jaira-desk.tail4c2e.ts.net"]
	mu.Unlock()
	p.listener.Close() // As the system does to a suspended app's listening socket.
	<-p.done
	if answers(first) {
		t.Fatal("the closed port still answers")
	}
	next, err := Proxy("http://jaira-desk.tail4c2e.ts.net")
	if err != nil {
		t.Fatal(err)
	}
	if next == first || !answers(next) {
		t.Fatalf("after the port was taken back: %d (was %d), answering %v", next, first, answers(next))
	}
}

func TestCloseProxiesLetsGoOfEveryPort(t *testing.T) {
	withIdleNode(t)
	first, err := Proxy("http://jaira-desk.tail4c2e.ts.net")
	if err != nil {
		t.Fatal(err)
	}
	CloseProxies()
	if answers(first) {
		t.Fatal("a port closed for the background still answers")
	}
	next, err := Proxy("http://jaira-desk.tail4c2e.ts.net")
	if err != nil || next == first || !answers(next) {
		t.Fatalf("back in front: %d, %v (was %d)", next, err, first)
	}
}

func TestProxyRefusesWhatIsNotAnAddressAndWaitsForStart(t *testing.T) {
	if _, err := Proxy("ftp://desk"); err == nil {
		t.Fatal("an ftp address was taken")
	}
	if _, err := Proxy("https://desk.tail4c2e.ts.net"); err == nil || !strings.Contains(err.Error(), "not started") {
		t.Fatalf("a proxy before the node: %v", err)
	}
}
