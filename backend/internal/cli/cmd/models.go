package cmd

import (
	"strings"

	"github.com/spf13/cobra"

	"ccy-canvas/backend/internal/cli/output"
)

var (
	modelsCapability string
	providersService string
	providersModel   string
)

var modelsCmd = &cobra.Command{
	Use:   "models",
	Short: "列出中转站模型目录(仅参考)",
	Long:  "列出 GET /api/app/models 的模型目录。注意:此列表的 id 不能当 provider_config_id 用;要选渠道请用 `ccy providers`。",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		items, err := c.ListModels(ctx())
		if err != nil {
			return err
		}
		if modelsCapability != "" {
			filtered := items[:0]
			for _, m := range items {
				if strings.EqualFold(m.Capability, modelsCapability) {
					filtered = append(filtered, m)
				}
			}
			items = filtered
		}
		if flagJSON {
			return output.JSON(items)
		}
		rows := make([][]string, 0, len(items))
		for _, m := range items {
			rows = append(rows, []string{m.ExternalModelName, m.DisplayName, m.Capability})
		}
		output.Table([]string{"模型名(调用用)", "展示名", "能力"}, rows)
		return nil
	},
}

var providersCmd = &cobra.Command{
	Use:   "providers",
	Short: "列出可用供应商渠道(拿 provider_config_id 的唯一来源)",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		items, err := c.ListProviders(ctx())
		if err != nil {
			return err
		}
		if flagJSON {
			return output.JSON(items)
		}
		// Cartesian expand: one row per (channel, model). model + the channel's
		// id are exactly what `generate` needs (model, provider-config-id).
		rows := make([][]string, 0)
		for _, p := range items {
			if providersService != "" && !strings.EqualFold(p.ServiceType, providersService) {
				continue
			}
			for _, m := range p.ModelList {
				if providersModel != "" && !strings.Contains(strings.ToLower(m), strings.ToLower(providersModel)) {
					continue
				}
				def := ""
				if m == p.DefaultModel {
					def = "默认"
				}
				rows = append(rows, []string{m, p.ServiceType, p.Vendor, p.Name, p.ID, def})
			}
		}
		output.Table([]string{"模型", "类型", "厂商", "渠道", "provider_config_id", ""}, rows)
		return nil
	},
}

func init() {
	modelsCmd.Flags().StringVar(&modelsCapability, "capability", "", "按能力过滤(text|image|video|audio)")
	providersCmd.Flags().StringVarP(&providersService, "service", "s", "", "按 service_type 过滤(text|image|video|audio)")
	providersCmd.Flags().StringVar(&providersModel, "model", "", "按模型名子串过滤")
}
