//go:build !windows

package application

import "os/exec"

func hideVisionMediaProcess(command *exec.Cmd) {}
