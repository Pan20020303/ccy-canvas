package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"ccy-canvas/backend/internal/cli/client"
	"ccy-canvas/backend/internal/cli/output"
)

var (
	tasksBatchNodeIDs []string
	watchTaskID       string
	watchOut          string
	watchTimeout      int
)

var tasksCmd = &cobra.Command{
	Use:   "tasks",
	Short: "任务查询(get / active / batch / watch)",
}

var tasksGetCmd = &cobra.Command{
	Use:   "get <task_id>",
	Short: "按 task_id 查询单个任务",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		item, err := c.GetTask(ctx(), args[0])
		if err != nil {
			return err
		}
		if flagJSON {
			return output.JSON(item)
		}
		printTasks([]client.TaskItem{item})
		return nil
	},
}

var tasksActiveCmd = &cobra.Command{
	Use:   "active",
	Short: "列出当前在途任务",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		items, err := c.ActiveTasks(ctx())
		if err != nil {
			return err
		}
		if flagJSON {
			return output.JSON(items)
		}
		printTasks(items)
		return nil
	},
}

var tasksBatchCmd = &cobra.Command{
	Use:   "batch",
	Short: "按 node_id 批量查询最近任务",
	RunE: func(cmd *cobra.Command, args []string) error {
		ids := append([]string{}, tasksBatchNodeIDs...)
		ids = append(ids, args...)
		if len(ids) == 0 {
			return fmt.Errorf("至少给一个 node id(--node-id 或位置参数)")
		}
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		items, err := c.BatchTasks(ctx(), ids)
		if err != nil {
			return err
		}
		if flagJSON {
			return output.JSON(items)
		}
		printTasks(items)
		return nil
	},
}

var tasksWatchCmd = &cobra.Command{
	Use:   "watch",
	Short: "订阅任务完成事件(SSE);带 --task-id 则等到该任务终态",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := newAuthedClient()
		if err != nil {
			return err
		}
		if watchTaskID != "" {
			wr, err := c.Wait(ctx(), watchTaskID, time.Duration(watchTimeout)*time.Second, false)
			if err != nil {
				if errors.Is(err, context.DeadlineExceeded) {
					return fmt.Errorf("等待超时,task_id=%s 仍在进行", watchTaskID)
				}
				return err
			}
			if wr.Status == "error" {
				return fmt.Errorf("任务失败: %s", wr.ErrorMsg)
			}
			urls := wr.ResultURLs
			if len(urls) == 0 && wr.ResultURL != "" {
				urls = []string{wr.ResultURL}
			}
			return finish(c, primaryOf("", urls), urls, watchTaskID, watchOut)
		}
		// No task id: stream all events until Ctrl-C / timeout.
		if !flagJSON {
			fmt.Fprintln(os.Stderr, "订阅任务事件中(Ctrl-C 退出)…")
		}
		streamCtx := ctx()
		if watchTimeout > 0 {
			var cancel context.CancelFunc
			streamCtx, cancel = context.WithTimeout(streamCtx, time.Duration(watchTimeout)*time.Second)
			defer cancel()
		}
		err = c.StreamEvents(streamCtx, func(ev client.TaskEvent) bool {
			if flagJSON {
				_ = output.JSON(ev)
			} else {
				fmt.Printf("[%s] task=%s node=%s %s\n", ev.Status, ev.TaskID, ev.NodeID, ev.ResultURL)
			}
			return false
		})
		if err != nil && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
			return err
		}
		return nil
	},
}

func printTasks(items []client.TaskItem) {
	rows := make([][]string, 0, len(items))
	for _, t := range items {
		result := t.ResultURL
		if t.ErrorMsg != "" {
			result = "err: " + t.ErrorMsg
		}
		rows = append(rows, []string{t.ID, t.NodeID, t.ServiceType, t.Status, result})
	}
	output.Table([]string{"task_id", "node_id", "类型", "状态", "结果"}, rows)
}

func init() {
	tasksBatchCmd.Flags().StringArrayVar(&tasksBatchNodeIDs, "node-id", nil, "node id(可重复)")
	tasksWatchCmd.Flags().StringVar(&watchTaskID, "task-id", "", "只等待某个 task_id")
	tasksWatchCmd.Flags().StringVar(&watchOut, "out", "", "终态成功时下载到目录/文件")
	tasksWatchCmd.Flags().IntVar(&watchTimeout, "timeout", 300, "超时(秒;0 表示不限)")
	tasksCmd.AddCommand(tasksGetCmd, tasksActiveCmd, tasksBatchCmd, tasksWatchCmd)
}
