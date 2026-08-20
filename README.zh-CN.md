# JB Git

[English](README.md) | [简体中文](README.zh-CN.md)

JB Git 是一款面向 Visual Studio Code 的 Git 扩展，目标是提供接近 IntelliJ IDEA 的 Git 工作流与操作体验。

项目采用独立的 TypeScript 实现，通过用户系统中安装的 Git 执行实际版本控制操作，不复制 JetBrains 的源代码、界面资源或商标。

## 主要功能

### IDEA 风格工作区

- Git 以原生底部 Panel 工具窗口显示，不占用活动栏侧边栏，也不会打开编辑器标签页。
- 同一个底部 Git 工具窗口包含 `Log`、`Console`、`Local Changes` 和 `Shelf` 四个页签。
- Local Changes 包含 Changelist、文件勾选、提交消息、Amend、Sign-off、跳过 Hooks、Commit 和 Commit and Push。
- Log 使用横向三栏布局：左侧 Branches、中间提交图和提交表、右侧 Changed Files 与 Commit Details；三栏宽度都可以拖动调节并自动记忆。
- Git Log 支持文本/哈希、Branch、User、Date、Paths 和顺序筛选；左侧分支支持 Command/Ctrl 多选、分支比较和文件差异。
- `Show Files Diff` 会打开 `Changes Between` 工作区：左侧按目录展示分支间文件变化，右侧使用 VS Code 原生并排代码 Diff，包含语法高亮、行号和行内增删高亮。
- Git Log 还支持彩色提交拓扑、Cherry-pick、Revert、从提交创建分支和 Reset。
- 状态栏分支入口提供类似 VCS Widget 的分支弹窗，更多菜单提供集中式 Git Operations Popup。
- Git Console 记录 Git 命令、耗时与输出，并在显示前隐藏 URL、令牌和认证信息。

### 本地更改

- 按已暂存、未暂存、未跟踪和冲突状态分组显示文件。
- 暂存、取消暂存和丢弃单个文件。
- 展开并暂存或取消暂存单个文本 Hunk。
- 打开 HEAD、Index 与工作区之间的文件差异。
- 双击冲突文件可打开 IDEA 风格三栏合并界面：左侧为当前分支，中间为可编辑最终结果，右侧为合入版本。
- 关闭界面后，可以再次双击冲突文件，或从命令面板运行 `JB Git: Open Merge Conflict Editor` 重新打开。
- 支持上一处/下一处冲突、逐块接受左侧/两侧/右侧、整文件接受左侧或右侧，以及拖动调整三栏宽度。
- 所有冲突标记处理完成后点击 `Apply`，插件会写入中间结果并自动暂存；`Cancel` 不会修改文件。
- 二进制冲突提供整文件 ours/theirs 安全回退。

### 提交与 Changelist

- 创建普通提交、修订提交和带 Sign-off 的提交。
- 支持跳过本地提交钩子。
- 创建 Changelist，并在不同 Changelist 之间移动文件。
- 通过隔离的临时 Index 提交指定 Changelist。
- 提交失败时保留用户原有的部分暂存状态。
- 正确处理重命名文件的新旧路径。

### 分支与远端

- 创建、切换、重命名和删除本地分支。
- 从本地分支、远端分支或标签创建新分支。
- 以 detached HEAD 模式检出标签。
- 创建和删除标签。
- Fetch、Pull、Push，以及受保护的 Force with Lease。
- 管理远端仓库和 Fetch/Push URL。
- 自动隐藏远端 URL 中可能存在的用户名、密码或访问令牌。

### 历史与高级操作

- 查看仓库历史、文件历史和提交详情。
- 对当前文件执行 Blame。
- Merge、Rebase、Cherry-pick、Revert 和 Reset。
- Continue、Abort 或 Skip 正在进行的 Git 操作。
- 启动和控制 Git Bisect。

### Shelf、Stash 与 Patch

- 创建、应用和删除 Shelf。
- Shelf 会先持久化补丁，再清理 Index 与工作区。
- 恢复 Shelf 后，修改默认保持为未暂存状态。
- 支持首次提交前的新增文件以及重命名文件。
- 创建、应用、弹出和删除 Stash。
- 从本地文件导入 Git Patch。

### 仓库与工作区

- 支持普通仓库、嵌套仓库、Bare Repository 和多根工作区。
- 支持 Git Worktree，并监视 linked worktree 的外部 Git 元数据。
- 初始化或克隆仓库时可选择目标工作区目录。
- 管理 Submodule、Sparse Checkout 和 Git LFS Pull。

## 实现架构

- Git Core 使用参数数组调用系统 `git`，不会通过 Shell 拼接命令。
- 使用 `git status --porcelain=v2` 等机器可读格式解析仓库状态。
- 仓库修改操作按仓库串行执行，降低并发写入 Index 的风险。
- VS Code Extension Host 负责命令、状态刷新和资源生命周期。
- 界面使用一个注册在底部 Panel 的统一 Git Webview、VS Code Diff Editor、Output Channel 和 Status Bar 实现。
- Changelist、Shelf、History、Remote、Stash、Worktree 和 Submodule 分为独立模块。

## 安装

### 从 VSIX 安装

1. 在 VS Code 中打开扩展视图。
2. 点击扩展视图右上角的 `...` 菜单。
3. 选择“从 VSIX 安装…”。
4. 选择项目生成的 `jb-git-0.1.4.vsix`。
5. 根据提示重新加载 VS Code。

也可以通过命令行安装：

```bash
code --install-extension jb-git-0.1.4.vsix
```

### 版本号规则

- 每一批可安装更新都递增版本号，并生成带版本号的全新 VSIX，不覆盖旧安装包。
- 修复更新递增补丁版本，例如 `0.1.3` → `0.1.4`；新增较大功能递增次版本；不兼容更新递增主版本。
- `package.json`、`package-lock.json`、Changelog 和安装文档中的版本由自动测试检查一致性。

## 本地开发

环境要求：

- Node.js 22 或兼容版本
- Git
- Visual Studio Code 1.95.0 或更高版本

安装依赖并编译：

```bash
npm install
npm run compile
```

运行测试：

```bash
# 核心与最新 VS Code Extension Host 测试
npm test

# 仅运行核心测试
npm run test:unit

# 验证最低支持版本 VS Code 1.95.0
npm run test:extension:min
```

生成 VSIX：

```bash
npm run package
```

在 VS Code 中按 `F5` 可以启动 Extension Development Host。

## 测试与兼容性

- 核心集成测试会创建临时 Git 仓库，验证真实 Git 操作结果。
- Extension Host 测试验证扩展激活、命令注册和关键存储流程。
- CI 在 Windows、macOS 和 Linux 上运行核心测试。
- Extension Host 矩阵覆盖 VS Code 1.95.0 与 stable。
- 打包流程会生成可直接安装的 VSIX 文件。

## 当前范围

当前版本已经按 IntelliJ IDEA 的主要工作流重新组织为底部 Git 工具窗口、Branches 弹窗和 Git Operations Popup。底部工具窗口的页签、信息层级、可调宽 Log 三栏、分支多选和提交筛选均以 IDEA 的 Git 窗口为基准；VS Code 自身的 Panel 标题栏、菜单与原生控件仍由 VS Code 渲染。

仍在规划中的主要能力包括：

- 三方冲突合并编辑器。
- Interactive Rebase、Squash 和 Fixup 编辑器。
- 超大仓库日志的分页、索引和图谱性能优化。
- 完整的多仓库事务回滚。
- 面向不同 Git 版本的能力检测与降级策略。
- SSH、WSL、Dev Container 和远程 Extension Host 的完整验证。
- 无障碍、发布、签名和 Marketplace 流程。

详细计划请参阅 [实现计划](docs/implementation-plan.md)。

## 项目结构

```text
src/
├── git/                 Git 命令、状态解析、补丁与类型
├── changelists/         Changelist 持久化与归属管理
├── shelves/             Shelf 补丁与元数据管理
├── views/               Diff Provider 与兼容节点
├── webviews/            底部 Git 工具窗口（Log、Console、Local Changes、Shelf）
├── repositoryManager.ts 仓库发现、刷新与操作编排
└── extension.ts         扩展激活、命令和 UI 生命周期

test/
├── *.test.mjs           Git Core 集成测试
└── suite/               VS Code Extension Host 测试
```

## 参考与归属

功能行为参考了公开的 IntelliJ Community Git/VCS 实现和相关文档：

- [IntelliJ Community GitHub 仓库](https://github.com/JetBrains/intellij-community)
- `plugins/git4idea`：Git 命令、仓库状态、分支、Rebase、Merge 和 Stash 行为。
- `platform/vcs-impl`：Changelist、Shelf、Patch、Diff 和 Merge 基础设施。
- `platform/vcs-log`：提交日志与图数据层。

本项目是独立的 clean-room TypeScript 实现，不复制 JetBrains 源代码、UI 资源或商标。项目使用 Apache-2.0 许可证，具体内容参阅 [LICENSE](LICENSE)。
