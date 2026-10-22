package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"ccy-canvas/backend/internal/cli/output"
)

var projectDeleteYes bool

var projectsCmd = &cobra.Command{
	Use:   "projects",
	Short: "项目管理(列出/创建/删除)",
}

var projectsListCmd = &cobra.Command{
	Use:   "list",
	Short: "列出我的与受邀协作的项目",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		items, err := c.ListProjects(ctx())
		if err != nil {
			return err
		}
		if flagJSON {
			return output.JSON(items)
		}
		rows := make([][]string, 0, len(items))
		for _, p := range items {
			collab := "-"
			if p.IsCollaborative {
				collab = "协作"
			}
			rows = append(rows, []string{p.ID, p.Name, p.MyRole, collab, p.UpdatedAt})
		}
		output.Table([]string{"ID", "名称", "角色", "协作", "更新时间"}, rows)
		return nil
	},
}

var projectsCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "创建项目",
	RunE: func(cmd *cobra.Command, args []string) error {
		name, _ := cmd.Flags().GetString("name")
		if name == "" {
			return fmt.Errorf("--name 必填")
		}
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		p, err := c.CreateProject(ctx(), name)
		if err != nil {
			return err
		}
		if flagJSON {
			return output.JSON(p)
		}
		fmt.Printf("已创建项目:%s(id=%s)\n", p.Name, p.ID)
		return nil
	},
}

var projectsDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "删除项目(仅创建者)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if !projectDeleteYes {
			fmt.Printf("将删除项目 %s(不可恢复)。加 --yes 确认。\n", args[0])
			return fmt.Errorf("已取消")
		}
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		if err := c.DeleteProject(ctx(), args[0]); err != nil {
			return err
		}
		if flagJSON {
			return output.JSON(map[string]any{"deleted": true, "id": args[0]})
		}
		fmt.Printf("已删除项目 %s\n", args[0])
		return nil
	},
}

func init() {
	projectsCreateCmd.Flags().String("name", "", "项目名(必填,1-100 字)")
	projectsDeleteCmd.Flags().BoolVarP(&projectDeleteYes, "yes", "y", false, "跳过确认")
	projectsCmd.AddCommand(projectsListCmd, projectsCreateCmd, projectsDeleteCmd)
}
