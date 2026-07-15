// Command ccy is a headless HTTP client for the CCY Canvas backend: log in,
// create projects, submit image/video/text generations, poll, and download —
// all from the terminal. It talks HTTP only and shares no code with the server
// runtime, so `go build ./cmd/ccy` produces a lightweight standalone binary.
package main

import "ccy-canvas/backend/internal/cli/cmd"

func main() {
	cmd.Execute()
}
