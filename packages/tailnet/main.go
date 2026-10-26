// jaira-tailnet: JaiRA's own way onto a tailnet, for a machine without the Tailscale app (decisions
// 0013 §2 and 0022). It is one node on the person's tailnet, made with Tailscale's embeddable library
// (./node), and JaiRA drives it over stdin and stdout for as long as JaiRA runs:
//
//	jaira-tailnet --dir <state dir> --hostname jaira-desk [--target 127.0.0.1:47318]
//
// What it says, one JSON object per line on stdout, is ./node's events, and these answers:
//
//	{"door":"https://mac-mini.tail4c2e.ts.net","local":"127.0.0.1:53211"}   a door, asked for
//	{"door":"…","error":"…"}
//	{"state":"signed-out"}                                                 after logout; then it exits
//
// What it is told, one JSON object per line on stdin:
//
//	{"cmd":"login"}       a new sign-in page
//	{"cmd":"logout"}      sign out, keeping the identity, and exit
//	{"cmd":"devices"}     say the devices now
//	{"cmd":"serve","target":"127.0.0.1:47318"}
//	{"cmd":"door","url":"https://mac-mini.tail4c2e.ts.net"}
//
// It exits when stdin closes, so it never outlives the JaiRA that started it. Nothing is exposed outside
// the tailnet (no Funnel).
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/ofersadgat/jaira/packages/tailnet/node"
)

var out sync.Mutex

func say(fields map[string]any) {
	line, _ := json.Marshal(fields)
	out.Lock()
	fmt.Println(string(line))
	out.Unlock()
}

func fail(message string) {
	say(map[string]any{"state": "error", "message": message})
	os.Exit(1)
}

func main() {
	dir := flag.String("dir", "", "where the node keeps its state (its identity on the tailnet)")
	hostname := flag.String("hostname", "jaira", "the node's name on the tailnet")
	target := flag.String("target", "", "the engine's loopback listener, host:port, to publish")
	flag.Parse()
	if *dir == "" {
		fail("--dir is required")
	}

	n := node.New(*dir, *hostname, say)
	if *target != "" {
		if err := n.Serve(*target); err != nil {
			fail(err.Error())
		}
	}
	if err := n.Start(); err != nil {
		fail(err.Error())
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		n.Close()
		os.Exit(0)
	}()

	lines := bufio.NewScanner(os.Stdin)
	lines.Buffer(make([]byte, 64*1024), 1024*1024)
	for lines.Scan() {
		var command struct {
			Cmd    string `json:"cmd"`
			Target string `json:"target"`
			URL    string `json:"url"`
		}
		if json.Unmarshal(lines.Bytes(), &command) != nil {
			continue
		}
		switch command.Cmd {
		case "login":
			if err := n.Login(); err != nil {
				say(map[string]any{"state": "error", "message": err.Error()})
			}
		case "logout":
			if err := n.Logout(); err != nil {
				say(map[string]any{"state": "error", "message": err.Error()})
				continue
			}
			say(map[string]any{"state": "signed-out"})
			n.Close()
			os.Exit(0)
		case "devices":
			n.Devices()
		case "serve":
			if err := n.Serve(command.Target); err != nil {
				say(map[string]any{"state": "error", "message": err.Error()})
			}
		case "door":
			local, err := n.Door(command.URL)
			if err != nil {
				say(map[string]any{"door": command.URL, "error": err.Error()})
			} else {
				say(map[string]any{"door": command.URL, "local": local})
			}
		}
	}
	n.Close()
}
