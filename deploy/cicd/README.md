# 无限画布的 CI/CD

## 日常更新

1. 从 `main` 建功能分支，提交并推送代码，创建 Pull Request。
2. `frontend` 执行全量前端测试和 TypeScript/Vite 构建；`backend` 在独立 PostgreSQL/Redis 上执行迁移、竞态检测、Go 检查和实际启动检查。失败时不能合并。
3. 合并至 `main` 后重新验证该提交，只打包测试通过的前端和后端文件，保留提交号和 SHA-256 校验和。
4. GitHub 使用专用部署账号上传发布包。服务器备份数据库及配置、验证迁移、逐个更新 9091 和 9090 实例，再切换前端。领取新任务会先暂停，已开始的任务有最多 35 分钟退出时间。
5. 服务和公网检查必须同时通过，前后端提交号必须一致。失败时恢复前后端至上一发布版本。每次发布结果在 Actions 中保留。

入口：https://github.com/Pan20020303/ccy-canvas/actions

## 回滚与状态

在 Actions 的 `production-operations` 中选择 `Run workflow`：

- `status`：检查两个后端实例与前端。
- `rollback` + `previous`：切换到上一发布。
- `rollback` + 完整提交号：切换到仍被保留的指定发布。

服务器保留最近五个发布，以及当前/上一版本。不可变的历史静态资源继续提供，避免已经打开的页面丢失旧的动态模块。

## 数据库边界

生产数据库、Redis、`.env`、上传文件、媒体缓存独立于发布包。发布包中没有生产凭据。

现有迁移在首次安装时核对线上结构并建立文件名及 SHA-256 记录。已执行的迁移禁止改写或删除。

新迁移必须是可以和旧代码共存的增量变更，并在 `deploy/cicd/migration-policy.json` 的 `backward_compatible` 中显式登记文件名和 SHA-256。新增迁移和记录在同一数据库事务中提交。未登记的迁移使发布失败；不得通过关闭检查发布。

自动回滚恢复应用程序和静态页面，**不会自动恢复旧数据库备份**，以免覆盖发布后用户写入的数据。删除列、重命名列和重写数据必须采用分阶段迁移与单独恢复方案。

## 服务器约定

- 发布目录：`/opt/ccy-canvas-runtime/releases/<commit>`。
- 后端指针：`/opt/ccy-canvas-runtime/current`；前端指针：`/opt/ccy-canvas-runtime/web`。
- 用户数据与配置：`/opt/ccy-canvas` 下的原有持久化目录和环境文件。
- 受限入口：`/usr/local/sbin/ccy-deploy`，只接受 `status`、`deploy`、`rollback`。
- 配置：`/etc/ccy-cicd.json`；备份：`/var/backups/ccy-cicd`，保留两份发布前快照。
- 日志：GitHub Actions 发布日志，以及两个 systemd 服务日志。

部署公钥使用 SSH 强制命令，不能用于普通 shell。主机公钥预先登记在 GitHub Secret 中；发布时不临时信任网络扫描结果。

## 初始化与演练

首次接入保存当前可用版本作为基线，保留原服务配置和数据库快照。完成一次真实流水线发布、一次回滚及重新发布后才视为接通。

`production-health` 每半小时检查公网的前后端状态和版本一致性。故障以失败的 Actions 运行记录呈现，通知使用仓库账号已有的 GitHub Actions 通知设置。
