package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"ccy-canvas/backend/internal/cli/config"
	"ccy-canvas/backend/internal/cli/output"
)

var (
	loginEmail    string
	loginPassword string
	regEmail      string
	regPassword   string
	regName       string
	regInvite     string
)

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "登录并保存会话到 ~/.ccy/session",
	RunE: func(cmd *cobra.Command, args []string) error {
		if strings.TrimSpace(loginEmail) == "" {
			return fmt.Errorf("--email 必填")
		}
		pw, err := resolvePassword(loginPassword)
		if err != nil {
			return err
		}
		c, err := newClient()
		if err != nil {
			return err
		}
		user, cookie, err := c.Login(ctx(), loginEmail, pw)
		if err != nil {
			return err
		}
		if err := config.SaveSession(cookie); err != nil {
			return err
		}
		// Persist the base-url we just used, for convenience on later calls.
		cfg, _ := config.Load()
		cfg.BaseURL = c.BaseURL
		_ = cfg.Save()

		if flagJSON {
			return output.JSON(map[string]any{"user": user})
		}
		fmt.Printf("已登录:%s <%s>(role=%s)\n", user.Name, user.Email, user.Role)
		return nil
	},
}

var registerCmd = &cobra.Command{
	Use:   "register",
	Short: "注册新账号并保存会话(可选邀请码)",
	RunE: func(cmd *cobra.Command, args []string) error {
		if strings.TrimSpace(regEmail) == "" || strings.TrimSpace(regName) == "" {
			return fmt.Errorf("--email 与 --name 必填")
		}
		pw, err := resolvePassword(regPassword)
		if err != nil {
			return err
		}
		c, err := newClient()
		if err != nil {
			return err
		}
		user, cookie, err := c.Register(ctx(), regEmail, pw, regName, regInvite)
		if err != nil {
			return err
		}
		if err := config.SaveSession(cookie); err != nil {
			return err
		}
		cfg, _ := config.Load()
		cfg.BaseURL = c.BaseURL
		_ = cfg.Save()

		if flagJSON {
			return output.JSON(map[string]any{"user": user})
		}
		fmt.Printf("已注册并登录:%s <%s>(role=%s)\n", user.Name, user.Email, user.Role)
		return nil
	},
}

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "登出并清除本地会话",
	RunE: func(cmd *cobra.Command, args []string) error {
		if c, err := newClient(); err == nil && c.Session != "" {
			_ = c.Logout(ctx()) // best-effort; local clear is what matters
		}
		if err := config.ClearSession(); err != nil {
			return err
		}
		if !flagJSON {
			fmt.Println("已登出")
		}
		return nil
	},
}

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "显示当前登录用户与积分额度",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		me, err := c.Me(ctx())
		if err != nil {
			return err
		}
		if flagJSON {
			return output.JSON(me)
		}
		output.KeyVals([][2]string{
			{"ID", me.User.ID},
			{"Name", me.User.Name},
			{"Email", me.User.Email},
			{"Role", me.User.Role},
		})
		if me.CreditSummary != nil {
			fmt.Println()
			output.KeyVals([][2]string{
				{"日额度", fmt.Sprint(me.CreditSummary.DailyQuota)},
				{"当前余额", fmt.Sprint(me.CreditSummary.CurrentBalance)},
				{"今日已用", fmt.Sprint(me.CreditSummary.ConsumedToday)},
			})
		}
		return nil
	},
}

// resolvePassword returns the flag value, else CCY_PASSWORD, else a hidden
// terminal prompt. It never echoes or logs the password.
func resolvePassword(flagVal string) (string, error) {
	if flagVal != "" {
		return flagVal, nil
	}
	if env := os.Getenv("CCY_PASSWORD"); env != "" {
		return env, nil
	}
	fmt.Fprint(os.Stderr, "密码: ")
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", fmt.Errorf("读取密码失败: %w", err)
	}
	return strings.TrimSpace(string(b)), nil
}

func init() {
	loginCmd.Flags().StringVarP(&loginEmail, "email", "e", "", "邮箱(必填)")
	loginCmd.Flags().StringVarP(&loginPassword, "password", "p", "", "密码(不填则隐藏输入;也可用 CCY_PASSWORD)")

	registerCmd.Flags().StringVarP(&regEmail, "email", "e", "", "邮箱(必填)")
	registerCmd.Flags().StringVarP(&regPassword, "password", "p", "", "密码(不填则隐藏输入;也可用 CCY_PASSWORD)")
	registerCmd.Flags().StringVar(&regName, "name", "", "昵称(必填)")
	registerCmd.Flags().StringVar(&regInvite, "invite", "", "邀请码(可选)")
}
