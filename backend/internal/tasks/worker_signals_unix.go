//go:build !windows

package tasks

import (
	"golang.org/x/sys/unix"
	"os"
	"os/signal"
)

// TSTP quiesces only task intake, leaving HTTP and active work alive.
// SIGTERM deliberately stays owned by cmd/api's graceful shutdown.
func listenForWorkerQuiesce(stop func()) func() {
	signals := make(chan os.Signal, 1)
	done := make(chan struct{})
	signal.Notify(signals, unix.SIGTSTP)
	go func() {
		for {
			select {
			case <-signals:
				stop()
			case <-done:
				return
			}
		}
	}()
	return func() { signal.Stop(signals); close(done) }
}
