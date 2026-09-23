package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"ccy-canvas/backend/internal/cli/output"
)

var downloadOut string

var downloadCmd = &cobra.Command{
	Use:   "download <url>",
	Short: "下载一个媒体 URL(私有/签名 URL 自动走后端代理)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		dest := downloadOut
		if dest == "" {
			dest = "."
		}
		p, err := c.Download(ctx(), args[0], dest)
		if err != nil {
			return err
		}
		if flagJSON {
			return output.JSON(map[string]string{"saved": p})
		}
		fmt.Fprintf(os.Stderr, "已保存 %s\n", p)
		return nil
	},
}

func init() {
	downloadCmd.Flags().StringVarP(&downloadOut, "out", "o", ".", "保存目录或文件路径")
}
