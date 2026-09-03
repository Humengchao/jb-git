# JB Git

[English](README.md) | [简体中文](README.zh-CN.md)

JB Git 是一款面向 Visual Studio Code 的 Git 扩展，目标是提供接近 IntelliJ IDEA 的 Git 工作流与操作体验。

项目采用独立的 TypeScript 实现，通过用户系统中安装的 Git 执行实际版本控制操作，不复制 JetBrains 的源代码、界面资源或商标。

## IDEA 能力对照

下表是当前能力口径的准确信息源：**已实现**表示当前代码已提供该工作流，**部分实现**表示已经可用但深度尚未达到 IDEA，**规划中**表示尚未实现，**明确不做**表示它是项目的非目标。

| IDEA 工作流 | 状态 | JB Git 当前行为与边界 |
| --- | --- | --- |
| Git 工具窗口与 Log | 部分实现 | 一个底部 `Git` Panel 提供 Log、Console、Local Changes 和 Shelf。提交图、筛选、分支比较、每次增量加载 300 条和大列表虚拟化已实现；持久化历史索引及超大仓库的完整搜索仍有差距。每个本地分支带 IDEA 的传入/传出标记——↓n 已抓取未合并、↑n 尚未推送，右对齐显示；上游被删除的分支显示 `gone` 而不是零。搜索框像 IDEA 一样分两层：输入即时筛选已加载的主题和元数据，回车把文本交给 Git 在全部历史中搜索提交消息（字面匹配、不分大小写，走与普通日志相同的读取路径，因此提交图、选中和虚拟化仍是同一套实现）；输入十六进制则跳转到该提交——即使它在已加载窗口之外，日志会以它为根重新加载。详情栏只为当前选中的提交按需读取完整消息，以保持大历史响应流畅。提交列表支持 IDEA 式多选——Ctrl/Cmd+点击切换、Shift+点击或 Shift+方向键扩展范围——详情栏会汇总所选提交；右键所选内容提供 **Cherry-Pick Selected**（按历史顺序逐个拣选，遇到冲突即停并说明完成到第几个，其余提交留给你重做）和恰好选中两个时的 **Compare Versions**（从旧到新的只读 diff）。宿主不信任 Webview 发来的点击顺序：以日志自身的顺序为准。所选提交还能像 IDEA 一样直接改写历史：**Drop Commit** 删除所选提交，**Squash Selected** 把它们聚拢到最旧的那个并合并全部消息，两者都降级为与序列编辑器相同的无人值守变基计划——同样的 stash 询问、同样的冲突停点、同样的拒绝条件（范围含 merge、选择不在线性历史上）；压缩不相邻的提交时，确认框会说明中间的提交将被重排。**编辑提交消息…**直接在详情面板里就地编辑（Ctrl/Cmd+Enter 保存、Esc 取消，草稿在刷新后仍然保留）：对最后一次提交只 amend 消息本身，已暂存的内容继续留给下一次提交；对更早的提交则作为 `reword` 行放到同一套无人值守的 rebase 计划上——同样的 stash 提示、同样的拒绝条件——并在重写分支前指出该提交已经推送。重写若因冲突停下，只会说明已停止，而不会同时宣称历史已重写——对 **Fixup…** 而言，只有重写完全没有执行时才会提示修正提交仍然孤立存在，因为暂停的 rebase 在继续后仍会把它折叠进去。**撤销提交…**就是 IDEA 对最后一次提交的软重置：分支退回父提交，改动保持已暂存；合并提交或正在进行 Git 操作时会被拒绝，确认框会说明该提交是否已到达远端。**将当前分支重置到这里…**提供 IDEA 的四种模式：Soft、Mixed、Hard 和 Keep。分支菜单新增 **Checkout 并 Rebase 到当前分支**：检出所选分支并把它变基到原先的当前分支上，本地修改全程贮藏，若 rebase 因冲突停下则留在贮藏中而不是回放到冲突之上。**Fixup…**与 IDEA 一致：把已暂存的改动并入所选提交——若是最后一次提交则直接 amend，否则先生成 `fixup!` 提交再通过同一套无人值守 rebase 计划折叠进去；目标是否在线性历史上会在提交之前检查，若拒绝了折叠、`fixup!` 提交留在分支上，也会明确告知。 |
| HEAD / Index / Working Tree 审阅 | 已实现 | Local Changes 明确展示两层差异：`HEAD → Index`（已暂存）和 `Index → Working Tree`（未暂存），均支持文件 Diff；文本文件还支持 Hunk 级暂存/取消暂存，并在写入 Index 前验证 Hunk 没有过期。工作区侧的 hunk 还带有 IDEA 的**回滚**：该处改动回到 Index 的内容，文件内其他改动和已暂存内容保持不变，并与其他回滚一样需要确认、同样在“搁置”中保留恢复条目。**创建补丁…**会把勾选的更改（与提交取用的选择一致，包含已暂存内容）保存为 `-p1` 补丁，`git apply` 与 IDEA 自身的 Apply Patch 都能应用。 |
| 两种 Commit 来源 | 已实现 | **Staging area (Index)** 只提交 Index 中的精确快照；**Selected files (complete contents)** 通过隔离的临时 Index 提交勾选文件的完整内容。后者也用于指定 Changelist 提交，失败时不会破坏用户真实 Index 的部分暂存状态。提交表单具备 IDEA 的消息便利：勾选 **Amend** 会自动填入被修正提交的消息、取消勾选恢复原来输入的内容；历史按钮提供最近 25 条真正提交过的消息（按仓库记忆、最新在前、重复使用会移到最前），即 IDEA 的 Commit Message History。未版本化文件会列出但默认不勾选——曾经的默认勾选让一次 Commit 差点带进 2475 个编辑器缓存文件。**作者…**字段可以以他人身份提交（`姓名 <邮箱>`，或让 Git 在历史中匹配的名字），从最近的作者补全，提交后自动清空；配置了 `commit.template` 时，空的消息框会像 IDEA 一样预填模板——其中的 `#` 行是注释，提交时按 Git 自己编辑器的规则剥除，只含模板的消息框不会启用提交按钮。 |
| Changelist | 部分实现 | 支持创建、重命名/描述、设为 Active、删除、整文件移动、重命名路径迁移和指定 Changelist 提交。**同一文件内的不同改动**现在可以像 IDEA 那样归属到不同 Changelist：展开文件会按 HEAD 列出它的各处改动及所属列表，`Move...` 可以改归属；提交某个 Changelist 时只取属于它的部分——文件所属列表提交别人没认领的全部（含之后新增的改动），认领方只提交自己认领的那些，其余留在工作区。改动是按其内容而不是行号记住的，所以周围行移动时归属不丢、跟随文件改名迁移、只有改动本身被撤销时归属才失效。以完整内容提交时，如果会把别的 Changelist 的工作一并带走，会先明确提示。单个 hunk 内部的重叠行级归属、任务上下文和 Changelist 冲突策略仍是差距。 |
| Rollback、Shelf 与未跟踪文件删除 | 已实现 | 回滚已跟踪文件前会先在 Shelf 保留 recovery entry；未跟踪文件通过系统 Trash 移除，不做不可恢复删除；冲突文件不允许单独回滚，以免静默丢掉一侧内容。未跟踪文件的**忽略…**与 IDEA 一致：可选择精确文件、所在目录或同扩展名的所有文件，写入仓库的 `.gitignore` 或仅本地克隆生效的 `.git/info/exclude`，规则会加锚点并转义，只命中所指的对象，且重复操作不会重复追加。 |
| 带本地修改的分支切换 | 已实现 | Smart Checkout 把已跟踪、已暂存和未跟踪修改保存到临时 Stash，以不可变 OID 定位，切换后恢复 Working Tree 与 Index。切换或恢复失败时 Stash 会保留供恢复。Log 的 Branches 面板与分支弹窗共享 IDEA 的分组和同一份收藏：**最近**列出近期检出过的分支（从 HEAD 的 reflog 读取，一次检出的两端都算），**收藏**列出用 ★ 按钮加星的分支——按工作区和仓库保存，分支删除后自动遗忘；每个有活跃上游的本地分支都提供**更新**，无需检出即可从上游快进（当前分支则执行 pull）。面板里星标就在分支行上，右键菜单也有同样的动作；任一侧加星都会同步到另一侧，Recent 背后的 reflog 只在引用真正变动时才重新读取。 |
| Push 安全流程 | 已实现 | Push 前先 Fetch，预览并执行精确的“本地 ref → 远端 ref”目标及 outgoing commits，并支持首次设置 upstream。目标分支命中可配置的 protected branch pattern 时禁用强推，其他目标只提供 Force with Lease；当前检出分支向既有 upstream 推送遇到 non-fast-forward rejection 时，可选择 Pull with Rebase/Merge 后重新预览。 |
| SHA-1 / SHA-256 对象 ID | 已实现 | Log 选择与消息校验接受完整的 40 位和 64 位十六进制对象 ID，最终对象解析仍交由 Git 校验。 |
| 合并冲突解决 | 部分实现 | 三栏界面与 IDEA 的解决方式一致：中间结果显示干净的文件内容而非 `<<<<<<<` 标记，每个冲突是随编辑移动的彩色区域；三栏之间的分隔条上绘制连接图形，把两侧代码块与结果区域连起来，并在每个更改旁提供成对按钮：箭头应用该侧，`×` 忽略该更改，已处理的更改则显示撤销箭头，因此应用一侧后另一侧的按钮栏不会变空。未解决为红色、已应用为绿色、手动改写为蓝色、已忽略为灰色，当前所在的更改在任何状态下都会加重显示；结果栏右侧有一条标记条显示整个文件里所有更改的位置，点击即可跳转；对同一冲突先后应用两侧即为"两者都保留"，剩余待解决计数归零后才能 Apply。整文件取舍、冲突导航（含 F7）、草稿恢复、外部修改防覆盖和可编辑结果均保留。Rebase 中会正确标为 **Rebase Target** 与 **Replayed Commit**，不会把 stage 2/3 错标成普通 ours/theirs。`JB Git: Resolve Simple Conflicts` 会在三个 stage 的副本上以 `diff3` 重放合并，使每个冲突块都带上 base，并自动解决只有唯一合理结果的块：两侧改动相同、仅一侧改动了 base，或两侧只有空白差异。只解决了一部分的文件会刻意保持未暂存；文件自身含冲突标记时直接拒绝而不靠猜测分块。工具栏新增 **Base** 开关，回答 IDEA 那个"这处更改原本是什么"——把当前更改的共同祖先文本浮在它上方（放不下时改到下方），该更改滚出视野时直接隐藏，而不是停在边缘让人误以为它属于别的行。由于工作区的冲突和 `diff3` 重放是两次独立计算、分块方式不一定相同，只有当重放得到的冲突数量、顺序和两侧内容都一致时才会配对；否则宁可不提供 base，也不会给某一块贴上另一块的历史。**Compare…** 按钮对应 IDEA 的 Compare contents：当前分支、基线、当前编辑中的结果、传入侧，四个版本任选两个在原生只读 diff 中并排打开，因此编辑器自己的折叠、搜索和空白字符设置都适用；add/add 冲突没有共同祖先，因此不提供涉及基线的组合。完整语义对齐仍有差距。Local Changes 中冲突文件的右键菜单还提供 IDEA 的**接受你的版本**和**接受对方版本**：整体采用一侧并标记为已解决，若该侧删除了文件则以删除来体现，两侧的名称按正在进行的操作给出，因此 rebase 期间“你的”指的是 rebase 目标而不是被重放的提交。 |
| Merge / Rebase / Cherry-pick / Revert / Reset | 部分实现 | 启动操作及 Continue/Abort/Skip 已实现，但历史编辑深度仍低于 IDEA。`JB Git: Merge Ref` 带有 IDEA 合并对话框的选项——不快进、仅快进、squash、不提交和允许不相关历史——互相矛盾的组合会在 Git 运行前被一句话拒绝。`JB Git: Rebase onto Ref` 就是 IDEA 的 Rebase 对话框：**Onto** 是所选分支，可选的 **From** 提交会变为 `--onto`，只移动该点之后的提交；**保留合并提交**即 `--rebase-merges`；**交互式**会在序列编辑器里列出 Git 自己会重放到该分支上的那些提交——补丁已经在目标分支上的提交会像 `git rebase` 一样被排除；脏工作区会得到贮藏提示，完成后恢复、因冲突停下时保留——Log 里的 “Rebase onto” 动作现在也是同样的处理。`JB Git: Pull` 就是 IDEA 的 Update Project：存在本地更改时提供**贮藏并更新**（完成后恢复，因冲突停下时保留）或**仍然更新**，并且可以取消。 |
| Interactive Rebase 编辑器 | 已实现 | `JB Git: Interactively Rebase from Commit` 会打开可视化序列编辑器（界面已本地化），支持拖拽手柄或 Alt+↑/↓ 重排以及 `pick`、`reword`、`edit`、`squash`、`fixup`、`drop`。`edit` 即 IDEA 的“停下修改”：变基应用该提交后停住（此时 Git 退出码为 0，因此扩展读取 sequencer 状态而不是相信退出码），提示你修改或测试后 Continue，暂存的本地更改也会保持暂存而不是恢复到正在修改的提交上。向“停下修改”的提交所在的组里 squash 会被拒绝——squash 的改写以组长的主题为守卫，而 edit 停点恰恰会改掉这个主题。改写消息的动作会降级为 Git 可无人值守执行的 todo，因此不会启动任何编辑器；冲突暂停后 `Continue` 仍会正确应用 reword 的消息。工作区有改动时会像 IDEA 一样提供 stash：只有真正开始 rebase 时才会暂存，结束后连同 Index 一起恢复；如果 rebase 因冲突停下，改动会保留在 stash 里，而不是叠加到未解决的冲突上。Git 自己的 `rebase.autoStash` 仍然关闭，因为它会无条件恢复。未跟踪文件不再算作阻塞——Git 本来就能在它们之上重放。相比 IDEA 更窄：起始提交必须是 HEAD 的祖先，范围内含 merge 时直接拒绝而不是压平，且不提供 `exec`/`break` 行。 |
| File History 与 Blame | 部分实现 | File History 和命令输出式 Blame 已实现，并能安全处理特殊路径。文件上的**与分支比较…**和**与修订比较…**与 IDEA 一致：另一分支/标签上的版本，或从该文件自身（跨重命名）历史中选出的某个修订，会在原生差异视图中与工作区版本对照打开。File History 会像 IDEA 一样跨重命名追踪文件（`--follow`，Git 只允许用于单个字面路径，因此 Log 里手动输入的后缀筛选仍是普通路径筛选）。**显示所选内容的历史**即 IDEA 的 Show History for Selection：在编辑器里选中若干行，Log 就收窄为改动过这些行的提交（跨重命名），路径筛选旁的 `Lines` 芯片可一键回到整个文件的历史。选区会先通过与 `HEAD` 的差异映射到已提交的文件上——替换掉旧行的新行继承旧行的历史，纯新增的选区会被告知尚无历史，未保存的缓冲区会先提示保存，因为磁盘上的差异看不到它。 |
| 编辑器 gutter Blame | 部分实现 | `JB Git: Annotate with Git Blame` 为每一行加上标注：作者、日期，以及可选的缩写对象 ID，各占一列并对齐，按该提交在本文件中的新旧程度着色。悬停可看到提交主题、作者、提交自身的日期与距今多久，并提供三个操作：在 Log 中定位该提交、复制 revision number、标注上一版本——后者用 Git 自己给出的 `previous <commit> <path>`，因此能沿改名回溯，而不是拿今天的路径去昨天的树里找。未保存的缓冲区通过 `git blame --contents` 标注，所以文档一变脏标注也不会错位；提交、amend 或 checkout 之后会重新读取。IDEA 注解的 Options 以设置项提供：**Ignore Whitespaces**（`-w`，使重新缩进不算作某行的最后一次修改），以及文件内（`-M`）和跨文件（`-C`）的移动/复制检测。把光标放到某个已注解的行上，会高亮该提交改动过的所有行——IDEA 是靠悬停触发的，而装饰无法感知指针位置；`JB Git: Annotate Revision` 可以按任意版本注解文件，并把该版本自身的行加粗。悬停里的提交主题也经过 Issue Navigation，配置过的缺陷编号会变成跟踪系统链接。**隐藏修订**是 IDEA 用来“看穿”一次格式化提交的方式：该修订的行会归到它之前的改动（`--ignore-rev`），隐藏的修订在同一文档里累积，直到执行 **显示隐藏的修订** 或关闭标注，悬停提示会显示隐藏了多少个。 |
| Issue Navigation | 已实现 | IDEA 的 Settings \| Version Control \| Issue Navigation，以 `jbGit.issueNavigation` 设置项提供：每条规则由一个正则表达式和一个链接模板组成，`$0` 是整个匹配、`$1`–`$9` 是捕获组——例如 `"[A-Z]+-\\d+"` → `https://youtrack.example.com/issue/$0`，或 `"#(\\d+)"` → 用 `$1` 拼出 issues 地址。凡是显示提交消息的地方——Log 的主题与正文、Blame 悬停——匹配到的编号都会变成指向跟踪系统的链接。文本重叠时先配置的规则获胜，顺序因此可预期；写坏的正则（或匹配空串的正则）只废掉那一条规则，不会废掉整个功能。扩展宿主和 Webview 运行的是同一个编译产物（注入而非拷贝），两边不会各自漂移。 |
| 多根仓库、嵌套仓库与 Worktree | 部分实现 | 已有仓库发现、按仓库串行写操作、linked worktree 元数据监视和外部普通文件变化刷新。刷新请求按 root/generation 精确保留，重新发现相同仓库时沿用对象及 mutation lock；跨仓库事务回滚仍在规划中。 |
| JetBrains 原生 UI、资源与像素级复刻 | 明确不做 | JB Git 是 clean-room VS Code 扩展，Panel 与编辑器外框由 VS Code 渲染，不复制 JetBrains 源码、控件、UI 资源或商标。 |

## 主要功能

### IDEA 风格工作区

- Git 以原生底部 Panel 工具窗口显示，不占用活动栏侧边栏，也不会打开编辑器标签页。
- 同一个底部 Git 工具窗口包含 `Log`、`Console`、`Local Changes` 和 `Shelf` 四个页签。
- Local Changes 包含 Changelist、文件勾选、提交消息、Amend、Sign-off、跳过 Hooks、Commit 和 Commit and Push。
- Log 使用横向三栏布局：左侧 Branches、中间提交图和提交表、右侧 Changed Files 与 Commit Details；三栏宽度都可以拖动调节并自动记忆。
- Git Log 支持文本/哈希、Branch、User、Date、Paths 和顺序筛选；左侧分支支持 Command/Ctrl 多选、分支比较和文件差异。
- `Show Files Diff` 会打开 `Changes Between` 工作区：左侧按目录展示分支间文件变化，右侧使用 VS Code 原生并排代码 Diff，包含语法高亮、行号和行内增删高亮。
- Git Log 还支持彩色提交拓扑、Cherry-pick、Revert、从提交创建分支和 Reset。
- 状态栏左下角有 `JB Git` 按钮，点一下即可打开底部 Git 工具窗口；面板被关掉后也能随时从这里回来。
- 状态栏分支入口提供类似 VCS Widget 的分支弹窗，更多菜单提供集中式 Git Operations Popup。
- Git Console 记录 Git 命令、耗时与输出，并在显示前隐藏 URL、令牌和认证信息。

### 本地更改

- 按已暂存、未暂存、未跟踪和冲突状态分组显示文件。
- 本地更改与提交详情里的文件名按状态着色（修改/新增/删除/重命名/未跟踪），与 IDEA 一致；界面渲染出错时会显示错误与“重置视图状态”按钮，而不是整个面板空白。
- 暂存或取消暂存单个文件；回滚已跟踪文件前保留 recovery Shelf，未跟踪文件移到系统 Trash。
- 展开并暂存或取消暂存单个文本 Hunk。
- 分别打开 `HEAD → Index` 与 `Index → Working Tree` 两层文件差异，不把已暂存和未暂存内容混为一种状态。
- 双击冲突文件可打开 IDEA 风格的左/结果/右三栏界面；普通 Merge 显示当前分支与合入版本，Rebase 则按实际 replay 语义显示 Rebase Target 与 Replayed Commit。
- 关闭界面后，可以再次双击冲突文件，或从命令面板运行 `JB Git: Open Merge Conflict Editor` 重新打开。
- 结果栏显示的是去掉 `<<<<<<<` 标记的干净内容：每个冲突是一个彩色区域，未解决为红、已应用为绿、手动改写为蓝、已忽略为灰。
- 三栏之间的分隔条会像 IDEA 一样画出连接图形，并在每个更改旁提供成对按钮：箭头应用该侧，`×` 忽略该更改；对同一冲突先后应用两侧即为“两者都保留”。
- 更改处理完后按钮会变成撤销箭头，可以只撤销这一处更改而不影响其他决定，所以任何一侧的按钮栏都不会变空。
- 支持上一处/下一处更改（F7 / Shift+F7）、逐块接受左侧/两侧/右侧（快捷键 1/2/3，输入结果时不生效）、整文件接受左侧或右侧，以及拖动调整三栏宽度；`Esc` 中止。
- 处理完一处更改后会自动滚动到下一处待解决的位置；语法高亮只渲染可视区域，因此几千行的大文件里编辑中间结果也不卡。
- 每一次按钮决定或一段连续输入都是一个撤销步骤（Ctrl/Cmd+Z 撤销，加 Shift 重做）；对方纯新增的冲突（我方一侧为空）会画成一条删除标记线而不是不可见；鼠标悬停在分隔条上滚轮仍然有效。
- 所有更改处理完成后点击 `Apply`，插件会写入无标记的中间结果并自动暂存；`Abort` 不会修改文件。
- 全部命令的原生对话框、通知、QuickPick 与进度提示均已本地化（`l10n/bundle.l10n.zh-cn.json`，400+ 条）。尚余：输入校验提示与变基计划校验消息（纯模块，不依赖 VS Code API），以及日志面板分支右键菜单中拼接分支名的少数菜单项。
- 二进制冲突提供整文件 ours/theirs 安全回退；二进制文件的普通 diff 会直接交给编辑器渲染，图片显示为图片对比，其他格式显示编辑器自带的提示，而不是弹一个通知。

### 提交与 Changelist

- 创建普通提交、修订提交和带 Sign-off 的提交。
- 支持跳过本地提交钩子。
- 可选择精确提交 Staging Area (Index)，或通过临时 Index 提交所选文件的完整内容。
- 创建 Changelist，并在不同 Changelist 之间移动文件。
- 通过隔离的临时 Index 提交指定 Changelist。
- 提交失败时保留用户原有的部分暂存状态。
- 正确处理重命名文件的新旧路径。

### 分支与远端

- 左侧 Branches 栏自带工具条（Fetch、Pull、Push、新建分支、更多操作）和按名称筛选输入框。
- 分支右键菜单提供 IDEA 同款操作：Push、Fetch、`Pull into <当前分支> using Merge/Rebase`、`Merge <分支> into <当前分支>`、`Rebase <当前分支> onto <分支>`、新建标签和删除标签。
- 创建、切换、重命名和删除本地分支。
- 有本地修改时使用 Smart Checkout：临时 Stash 后切换并恢复 Working Tree 与 Index，恢复失败仍保留可恢复的 Stash。
- 从本地分支、远端分支或标签创建新分支。
- 以 detached HEAD 模式检出标签。
- 创建和删除标签。
- Fetch、Pull 与带预览的 Push；Push 显示目标及 outgoing commits，protected branch 禁止强推，其他分支仅允许 Force with Lease，rejected push 可选择 Rebase/Merge 后重试。
- 管理远端仓库和 Fetch/Push URL。
- 自动隐藏远端 URL 中可能存在的用户名、密码或访问令牌。

### 历史与高级操作

- 查看仓库历史、文件历史和提交详情。
- 本地分支、远端分支和标签使用不同图标区分，选中提交的全部引用会显示在右侧详情中。
- 双击提交或使用 `Compare with Local` 打开的差异为只读编辑器，关闭时不会提示保存。
- 对当前文件执行输出式 Blame，或用 `JB Git: Annotate with Git Blame` 在编辑器里逐行标注，并从悬停跳转到提交或上一版本。
- Log 与提交选择支持 Git 的完整 SHA-1（40 位）和 SHA-256（64 位）对象 ID。
- Merge、Rebase、Cherry-pick、Revert 和 Reset。
- Continue、Abort 或 Skip 正在进行的 Git 操作。
- 启动和控制 Git Bisect。

### Shelf、Stash 与 Patch

- 创建、应用和删除 Shelf。
- Shelf 会先持久化补丁，再清理 Index 与工作区。
- 恢复 Shelf 后，修改默认保持为未暂存状态。
- 支持首次提交前的新增文件以及重命名文件。
- 创建、应用、弹出和删除 Stash。
- 从提交创建并保存 Git Patch。
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
4. 选择项目生成的 `jb-git-0.1.29.vsix`。
5. 根据提示重新加载 VS Code。

也可以通过命令行安装：

```bash
code --install-extension jb-git-0.1.29.vsix
```

### 版本号规则

- 每一批可安装更新都递增版本号，并生成带版本号的全新 VSIX，不覆盖旧安装包。
- 修复更新递增补丁版本，例如 `0.1.3` → `0.1.4`；新增较大功能递增次版本；不兼容更新递增主版本。
- `package.json`、`package-lock.json`、Changelog 和安装文档中的版本由自动测试检查一致性。

### 自动发布到 Marketplace

Release 流水线已经实现并自动运行。每次推送到 `main` 都会触发 GitHub Actions 的 `Release` 工作流：

1. 在 Linux、macOS、Windows 上运行核心测试，并在 VS Code 1.95.0 与 stable 上运行扩展宿主测试。
2. 自动递增补丁版本，同步更新 `package.json`、`package-lock.json`、Changelog 和安装文档。
3. 打包 VSIX；配置了 `VSCE_PAT` 时发布到 Visual Studio Marketplace。
4. 回写 `chore: release <版本>` 提交、打上 `v<版本>` 标签，并创建附带 VSIX 的 GitHub Release。

全部测试通过才会发布。如果某次提交不想触发发布，在提交标题里加上 `[skip release]`：

```bash
git commit -m "docs: 修正错别字 [skip release]"
```

需要发布次版本或主版本时，在 Actions 页面手动运行该工作流并选择要递增的位数，其余步骤相同。

发布到 Marketplace 需要仓库 Secret `VSCE_PAT`：一个 Azure DevOps 个人访问令牌，Organization 选 **All accessible organizations**，Scope 勾选 `Marketplace (Manage)`，并且必须用拥有 `hmc` 发布者的那个 Microsoft 账号创建。创建令牌需要先有 Azure DevOps 组织，请访问 <https://aex.dev.azure.com/>——不要用 Azure Portal，它不接受个人 Microsoft 账号。

没有配置该 Secret 时工作流依然会运行：测试、升版本、打标签、把 VSIX 附加到 GitHub Release，并提示已跳过市场上传，可以在发布者页面手动上传。

回写提交使用内置的 `GITHUB_TOKEN`，它不会再次触发工作流，因此不会出现发布循环。

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

### 查看界面实际渲染

测试套件不渲染任何 Webview：它们检查源码文本、驱动真实 Git、激活扩展宿主。这个缺口曾经藏住一个脚本无法解析的序列编辑器——面板标题正确、内容全空，而所有测试都是绿的。`scripts/screenshot.mjs` 会在真实 VS Code 里打开指定界面并截图，这类问题一条命令即可发现：

```bash
node scripts/screenshot.mjs --list
node scripts/screenshot.mjs rebase --out /tmp/rebase.png
```

每次运行会新建一个用完即弃的仓库。Linux 上需要显示环境和截图工具（`xvfb`、`imagemagick` 以及 Electron 常用的那几个库）；macOS 上会直接在桌面打开窗口并用系统自带的 `screencapture` 截图，只需授予终端“屏幕录制”权限。它是手动工具而不是 CI 步骤，因为"看图"本身才是重点。

## 测试与兼容性

- 核心集成测试会创建临时 Git 仓库，验证真实 Git 操作结果。
- Extension Host 测试验证扩展激活、命令注册和关键存储流程。
- CI 在 Windows、macOS 和 Linux 上运行核心测试。
- Extension Host 矩阵覆盖 VS Code 1.95.0 与 stable。
- 打包流程会生成可直接安装的 VSIX 文件。

## 当前范围

当前版本已经按 IntelliJ IDEA 的主要工作流组织为底部 Git 工具窗口、Branches 弹窗和 Git Operations Popup；VS Code 自身的 Panel 标题栏、菜单与原生控件仍由 VS Code 渲染。上面的能力对照表是“已实现”与“IDEA 完整对等”之间的边界，不应把命令存在等同于完整 parity。

接下来的主要差距是完整 Base-aware 三方 Merge、Blame 的移动/复制检测、同文件多 Hunk 的 Changelist ownership、跨仓库事务回滚、持久化大历史索引，以及 SSH、WSL、Dev Container、远程 Extension Host、无障碍和不同 Git 版本的系统性验证。

发布不再属于待办：跨平台测试、版本递增、VSIX、标签和 GitHub Release 流水线已经实现，Marketplace 上传只取决于 `VSCE_PAT`。项目目前不宣称提供 VSIX/代码的密码学签名，也没有实现 Git Commit 的 GPG 签名；这两类“签名”与现有 Sign-off 不是同一能力。

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
