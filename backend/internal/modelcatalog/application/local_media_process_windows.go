//go:build windows

package application

import (
	"os/exec"
	"syscall"
)

func hideMediaProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
