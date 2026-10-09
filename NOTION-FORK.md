# Notion Fork 使用与维护

这个分支在官方 Notebase 之外增加 Notion 保存目标。未配置 Notion 的动作继续使用原有 Notebase；启用 Notion 后，该动作的保存按钮与笔记建议写入 Notion。断开 Notion 可以恢复 Notebase 连接，不需要重新配置官方笔记库。

## 构建和安装

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
WXT_SKIP_ENV_VALIDATION=true pnpm build
```

在 Chrome 或 Edge 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，载入 `.output/chrome-mv3`。构建输出不提交到 Git。

`WXT_SKIP_ENV_VALIDATION=true` 是上游已有的个人构建开关，允许缺少 Google OAuth 与 PostHog 环境变量。它不会提供这些服务的凭据，也不会绕过 Notion 鉴权。需要使用 Google 登录时，请根据 `.env.example` 配置自己的 OAuth 客户端。

## 配置 Notion

1. 在 Notion 创建内部集成，授予读取内容和插入内容权限，并把目标数据库连接到该集成。
2. 取得数据库中目标 **Data Source ID**。数据库 URL 中的 Database ID 与 Data Source ID 不一定相同。可通过 `GET /v1/databases/{database_id}` 查看 `data_sources` 列表。
3. 打开扩展设置 → 自定义 AI 动作 → 选择动作 → 笔记库页签，下方有 Notion 配置区。内置词典等动作也支持配置。
4. 填写内部集成令牌并点击 **Save token**。令牌由所有动作共用，只存入当前扩展的本地存储，不进入配置导出、自动备份或配置同步。
5. 填写 Data Source ID，点击 **Load / refresh fields**。
6. 将文本输出映射到 Title 或 Rich text，数字输出映射到 Number。必须有一个标题映射，同一个 Notion 属性只能使用一次。
7. 点击 **Enable Notion**。生成 AI 结果后，按钮显示 **Save to Notion**；保存成功提示可以直接打开新页面。

此版本支持 Title、Rich text、Number。映射使用动作字段 ID 和 Notion 属性 ID，重命名不会使映射失效。每次保存重新读取结构；字段删除或类型变化时会提示修复映射。修改数据源后需要重新读取字段并启用连接。

令牌不会回填到界面，也不会传给内容脚本；只有扩展设置页可以修改或移除令牌。卸载扩展会删除本地令牌，导入配置到另一浏览器后需要重新填写。浏览器扩展本地存储不是系统密钥库。

批量保存按顺序进行，单次最多 100 条。遇到 `429` 会遵守 `Retry-After`，最多请求三次；等待时间超过 30 秒时提示稍后重试。网络中断或服务端错误不会自动重试创建页面，因为服务端可能已经创建成功。失败提示会报告已确认保存的数量；请先检查 Notion 再重试。同一界面、同一连接、同一批结果的重试会跳过已确认成功的前缀；重新加载界面或改变结果后不会保留这份进度。

## 架构与合并范围

新增代码集中在以下位置：

- `src/utils/note-storage/`：连接类型、后台 Provider 接口、Notion API 与字段转换。
- `src/entrypoints/background/notion-storage.ts`：令牌存储、消息校验、配置解析和跨标签页保存队列。
- `src/components/custom-action/use-save-to-note-storage.ts`：统一保存入口，按动作连接分发到原有 Notebase hook 或独立 Notion hook。
- `src/entrypoints/options/pages/custom-actions/action-config-form/notion-connection-field.tsx`：独立配置组件。

上游接入点是动作 schema 和内置状态合并、后台注册、消息类型、配置页组件、自定义动作保存按钮和笔记建议保存入口。`use-save-to-notebase.ts`、官方登录和额度逻辑、AI 生成流程及原有字段映射保持原样。无需新增依赖或更改清单主机权限：上游 `*://*/*` 已覆盖 `https://api.notion.com/*`。

连接保存为可选的 `notionConnection`，包含 `provider: "notion"`、Data Source ID 和字段映射。旧配置没有该字段时沿用 Notebase，因此无需改变上游迁移版本号。上游原版不能识别这个新增字段；不要让原版与 Fork 共用并反复覆盖同一份远程同步配置。切回上游前导出一份 Fork 配置作为备份。

## Git 管理

本地保留 `main` 作为上游基线，功能位于 `feature/notion-note-storage`。官方远程命名为 `upstream`，个人 GitHub Fork 使用 `origin`。

远程 Fork 为 [olansoft/read-frog](https://github.com/olansoft/read-frog)，本次已经配置好 `origin` 与 `upstream`。在另一台电脑上使用功能分支时：

```sh
git clone --branch feature/notion-note-storage https://github.com/olansoft/read-frog.git
cd read-frog
git remote add upstream https://github.com/mengxi-ream/read-frog.git
```

同步上游时先确保工作区干净，再执行：

```sh
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch feature/notion-note-storage
git merge main
```

用 merge 同步已推送的 Fork 分支，保留提交历史，避免强制推送。若仅在本地尚未共享，可自行选择 rebase。冲突优先保留上游原有功能，再恢复上述少量接入点；不要批量覆盖整个文件。

验证后提交并推送。推荐验证命令：

```sh
pnpm type-check
SKIP_FREE_API=true pnpm test
WXT_SKIP_ENV_VALIDATION=true pnpm build
```

真实 API 验证需要自己的 Notion 集成和测试数据源：检查单条写入、批量写入、属性重命名、移除集成访问权限与导出配置不包含令牌。自动化测试使用模拟响应，不向真实数据库写入。

## API 依据

请求固定使用 `Notion-Version: 2026-03-11`，以 Data Source ID 创建页面。

- [读取 Data Source](https://developers.notion.com/reference/retrieve-a-data-source)
- [创建页面](https://developers.notion.com/reference/post-page)
- [API 限流和大小限制](https://developers.notion.com/reference/request-limits)

## 自动同步与 CRX 发布

Fork 的默认分支为 `feature/notion-note-storage`，`main` 保留为上游基线。GitHub Actions 每小时第 23 分钟检查官方仓库的最新稳定 Release；不跟踪预发布版本，也不跟踪尚未发布的 main 提交。GitHub 定时任务可能排队延迟。

发现新 Release 后，流程把发布标签对应的提交合并到 Notion 分支，然后运行类型检查、测试和构建，生成固定密钥签名的 CRX 与 ZIP。Notion 分支的每次 push 也会独立触发打包。上游同步使用 `GITHUB_TOKEN` 推送时不会触发另一次 push 工作流，因此同步任务直接调用打包工作流。

`.github/workflows` 由 Fork 自己维护，同步时保留该目录的现有内容；其余文件正常合并。这样既避免官方 Changesets/商店发布流程覆盖 Fork 流程，也无需额外保存具备 workflow 权限的个人令牌。源码冲突时终止合并且不推送，需要手动解决后重新运行。上游 Release 仅在打包成功后记录完成标记，失败构建会在下次轮询重试。

产物在本仓库 Releases 中以 `notion-build-N` 预发布版本提供，并附带 SHA256 校验文件；Actions Artifacts 保留 90 天。CRX 的版本在上游三段版本后追加 workflow run number，例如 `1.50.2.12`，保证同一上游版本下的 Notion 更新也能递增。run number 超过 Chrome 的 65535 上限时，流程会明确失败，需要调整版本策略。

固定签名密钥存放在仓库 Actions Secret `CRX_SIGNING_KEY`；本地备份是 `.fork-private/crx-signing-key.pem`，该目录被 Git 忽略。请另外备份这份密钥，后续不要重新生成，否则扩展 ID 会改变。工作流只上传 CRX、ZIP 与校验文件，不上传私钥。

手动检查上游或重打包：打开 Actions → **Notion fork - Sync and package** → **Run workflow**。定时任务依赖默认分支中的工作流，因此请保持 Notion 分支为 Fork 默认分支。自动化失败时查看 Actions 日志；合并冲突与签名缺失不会静默跳过。

CRX 可否直接安装取决于浏览器的扩展安装策略；同时提供的 ZIP 可以解压后通过“加载已解压的扩展程序”安装。这套流程发布构建文件，不配置浏览器端的自动更新服务器。

- [GitHub 工作流触发与 GITHUB_TOKEN](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Chrome CRX 签名与分发](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)
