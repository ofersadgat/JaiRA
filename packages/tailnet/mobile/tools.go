//go:build tools

// gomobile bind needs golang.org/x/mobile among the module's requirements.
package tailnet

import _ "golang.org/x/mobile/bind"
