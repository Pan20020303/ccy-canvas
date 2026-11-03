//go:build windows

package application

import (
	"os/exec"
	"syscall"
)

func hideVisionMediaProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
