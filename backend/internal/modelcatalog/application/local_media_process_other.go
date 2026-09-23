//go:build !windows

package application

import "os/exec"

func hideMediaProcess(cmd *exec.Cmd) {}
