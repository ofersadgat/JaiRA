package tailnet

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
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

func TestProxyRefusesWhatIsNotAnAddressAndWaitsForStart(t *testing.T) {
	if _, err := Proxy("ftp://desk"); err == nil {
		t.Fatal("an ftp address was taken")
	}
	if _, err := Proxy("https://desk.tail4c2e.ts.net"); err == nil || !strings.Contains(err.Error(), "not started") {
		t.Fatalf("a proxy before the node: %v", err)
	}
}
