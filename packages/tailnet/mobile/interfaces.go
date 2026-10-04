package tailnet

import (
	"net"
	"strconv"
	"strings"

	"tailscale.com/net/netmon"
)

// InterfaceSource lists the phone's network interfaces where Go cannot: on Android 11 and later the
// system refuses Go's netlink request ("route ip+net: netlinkrib: permission denied") and the node does
// not start. Java can still list them, so the app hands them over, as Tailscale's own Android app does.
//
// One interface per line:
//
//	<name> <index> <mtu> <up> <broadcast> <loopback> <pointToPoint> <multicast> | <addr>/<prefix> …
type InterfaceSource interface {
	Interfaces() string
}

// UseInterfaces makes the node ask source for the interfaces, every time it looks. Call it before Start.
func UseInterfaces(source InterfaceSource) {
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		return parseInterfaces(source.Interfaces()), nil
	})
}

func parseInterfaces(spec string) []netmon.Interface {
	var out []netmon.Interface
	for _, line := range strings.Split(spec, "\n") {
		head, tail, _ := strings.Cut(line, "|")
		f := strings.Fields(head)
		if len(f) < 8 {
			continue
		}
		index, _ := strconv.Atoi(f[1])
		mtu, _ := strconv.Atoi(f[2])
		var flags net.Flags
		for i, flag := range []net.Flags{net.FlagUp, net.FlagBroadcast, net.FlagLoopback, net.FlagPointToPoint, net.FlagMulticast} {
			if f[3+i] == "true" {
				flags |= flag
			}
		}
		var addrs []net.Addr
		for _, a := range strings.Fields(tail) {
			if _, ipnet, err := net.ParseCIDR(a); err == nil {
				ip, _, _ := net.ParseCIDR(a)
				addrs = append(addrs, &net.IPNet{IP: ip, Mask: ipnet.Mask})
			}
		}
		out = append(out, netmon.Interface{Interface: &net.Interface{Index: index, MTU: mtu, Name: f[0], Flags: flags}, AltAddrs: addrs})
	}
	return out
}
