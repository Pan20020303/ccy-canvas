// Package cmd defines the ccy CLI's cobra command tree.
package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"ccy-canvas/backend/internal/cli/client"
	"ccy-canvas/backend/internal/cli/config"
)

var (
	flagBaseURL string
	flagJSON    bool
)

var errNotLoggedIn = errors.New("未登录,请先运行 `ccy login`")

var rootCmd = &cobra.Command{
	Use:           "ccy",
	Short:         "ccy — 橙次元(CCY Canvas)无头命令行客户端",
	Long:          "ccy 通过 HTTP 驱动 CCY Canvas 后端:登录、建项目、提交图/视频/文本生成、轮询、下载。\n鉴权走 ccy_session Cookie(登录后存于 ~/.ccy/session,权限 0600)。",
	SilenceUsage:  true,
	SilenceErrors: true,
}

func init() {
	rootCmd.PersistentFlags().StringVar(&flagBaseURL, "base-url", "", "后端地址(默认 http://localhost:8080,可用环境变量 CCY_BASE_URL)")
	rootCmd.PersistentFlags().BoolVar(&flagJSON, "json", false, "以 JSON 输出(便于脚本)")

	rootCmd.AddCommand(
		loginCmd, registerCmd, logoutCmd, whoamiCmd,
		projectsCmd, modelsCmd, providersCmd,
		generateCmd, tasksCmd, downloadCmd,
	)
}

// Execute runs the CLI and exits with a status code derived from the error.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(exitCodeFor(err))
	}
}

func exitCodeFor(err error) int {
	var ae *client.APIError
	if errors.As(err, &ae) {
		return ae.ExitCode()
	}
	if errors.Is(err, errNotLoggedIn) {
		return 2
	}
	return 1
}

// newClient builds a client from the resolved base-url + stored session.
func newClient() (*client.Client, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	base := config.ResolveBaseURL(flagBaseURL, cfg)
	sess, err := config.LoadSession()
	if err != nil {
		return nil, err
	}
	return client.New(base, sess), nil
}

// newAuthedClient errors early (no request) when there's no stored session.
func newAuthedClient() (*client.Client, error) {
	c, err := newClient()
	if err != nil {
		return nil, err
	}
	if c.Session == "" {
		return nil, errNotLoggedIn
	}
	return c, nil
}

func ctx() context.Context { return context.Background() }
