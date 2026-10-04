package tailnet

import "testing"

func TestParseInterfaces(t *testing.T) {
	got := parseInterfaces("wlan0 30 1500 true true false false true | 192.168.1.23/24 fe80::1/64\nlo 1 65536 true false true false false | 127.0.0.1/8\nbroken line\n")
	if len(got) != 2 {
		t.Fatalf("want 2 interfaces, got %d", len(got))
	}
	w := got[0]
	if w.Name != "wlan0" || w.Index != 30 || w.MTU != 1500 || !w.IsUp() || w.IsLoopback() || len(w.AltAddrs) != 2 || w.AltAddrs[0].String() != "192.168.1.23/24" {
		t.Fatalf("wlan0 read as %+v %v", w.Interface, w.AltAddrs)
	}
	if !got[1].IsLoopback() {
		t.Fatal("lo is loopback")
	}
}
