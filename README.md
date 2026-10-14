# C/C++ 调用关系图

> 许可：MIT ｜ 运行环境：Visual Studio Code 1.75 及以上 ｜ 运行时依赖：无

一个通过 **Vibe coding** 方式开发的 Visual Studio Code 自用扩展，用于在底部面板中以图形方式浏览 C/C++ 函数的调用关系。

右键菜单提供两个查询命令：

- **被调用关系图** —— 查询当前函数的调用者
- **调用关系图** —— 查询当前函数所调用的函数

## 安装

```powershell
# 请勿双击 .vsix（Windows 会交给 Visual Studio 安装器）
code --install-extension .\cpp-call-graph-<版本>.vsix
```

## 前置条件

调用关系数据由 VS Code 的 Call Hierarchy 接口提供，其上游为本机的 C/C++ 语言服务：

| 语言服务                   | 所需条件                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **clangd**                 | ① 本机存在 `clangd` 可执行文件（clangd 扩展仅为客户端，需另行安装，例如 `winget install LLVM.LLVM`）；<br />② 工程内存在 `compile_commands.json` 或 `compile_flags.txt`（CMake 工程可执行 `cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` 生成） |
| **C/C++ 扩展（cpptools）** | IntelliSense 完成对工程的解析                                                                                                                                                                                                                                  |

注意：`clang.exe` 为编译器，不提供调用关系；需同时具备 clangd 扩展与 `clangd` 可执行文件。

## 设置项


> **作用域**：全部设置都是 `window`（用户设置里能写、工作区设置里也能写，**工作区值优先**），唯一例外是 `customEngines`（`machine-overridable`：按机器生效、不会被设置同步带走，允许工作区覆盖）。多根工作区下这些设置**不区分根目录**（读的是窗口级配置）。

| 设置                              | 默认值    | 建议位置 | 说明                                                                                                                                                                |
| --- | --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cppCallGraph.languageService` | `auto` | 用户 | 提供调用层级的语言服务：`auto` 自动探测 / `clangd` / `cpptools` / `any` 不指定引擎 / `custom` 用 `customEngineId` |
| `cppCallGraph.enginePickPolicy` | `nearest` | 用户 | 多引擎返回候选时的挑选策略：`nearest` / `preferSelected` / `onlySelected`（后者可能查不出结果） |
| `cppCallGraph.customEngineId` | 空 | 用户 | `languageService` 取 `custom` 时使用的引擎 id |
| `cppCallGraph.customEngines` | `[]` | 用户（本机） | 自定义语言服务列表，字段：`id` / `label` / `extensionId` / `badge` / `matchName` / `matchDetail` / `advice` |
| `cppCallGraph.showEngineWarning` | `true` | 用户 | 检测到多个语言服务可能同时提供调用层级时给出提示 |
| `cppCallGraph.autoReveal` | `true` | 用户 | 双击方框时打开文件并定位到声明处（单击仅选中） |
| `cppCallGraph.stickyParent` | `true` | 用户 | 纵向滚动时把已展开下一层的方框固定在窗口垂直中央，各自限在自己的子树范围内滑动 |
| `cppCallGraph.maxChildrenPerNode` | `200` | 用户 | 每个方框最多保留的直接调用者 / 被调用者数量；超出部分不显示，悬停提示给出条数 |
| `cppCallGraph.maxExpandRounds` | `5` | 用户 | 「展开全部」的层数上限；「完全展开」不受该上限约束 |
| `cppCallGraph.maxLayoutNodes` | `800` | 用户（大项目可在工作区覆盖） | 整张图的节点总数上限（100–5000）；超出部分不上图并写入输出通道，同时约束两种批量展开的节点预算 |
| `cppCallGraph.showLocation` | `true` | 工作区 | 方框中是否显示「文件路径:行号」一行；关闭后仅显示元素名，方框收窄为单行 |
| `cppCallGraph.pathDisplay` | `tail` | 工作区 | 路径显示方式：`tail` 保留末尾若干层与锚点段 / `full` 显示整条路径；两者都不截断文字 |
| `cppCallGraph.pathTailLevels` | `0` | 工作区 | `tail` 模式末尾保留的层数（含文件名）；`0` 表示按方框宽度自动 |
| `cppCallGraph.pathShowFileName` | `true` | 工作区 | 那行路径是否包含文件名；关闭后只显示目录部分，`:行号` 保留 |
| `cppCallGraph.pathAnchors` | 空 | 工作区 | 必须显示的目录段，逗号分隔。**段**：`src` / `lib*` / `a\|b` / `re:^tests?$` / `**` / `"a*b"`；**路径**：`src/lib`（连续出现，锚点取末段）、`/src/lib`（从工作区根）；**位置**：`+2` / `-1` / `src+1` / `src/lib+1`；**前缀**：`all:` / `!` / `keep:`；**后缀**：`@deepest` / `@first`；**括号 = 标签**：`(src+1)` 两处都要、`[lib]` 只要标签、裸写只进路径那行。示例见设置项说明 |
| `cppCallGraph.nameFolderTag` | `false` | 工作区 | 是否在元素名同一行显示路径标签（标签来自 `pathAnchors` 的括号条目） |
| `cppCallGraph.nameFolderTagStyle` | `arrow` | 工作区 | 标签摆法：`arrow` = `[include] → 元素名`；`parenAfter` = `元素名 (include)`；`bracketAfter` = `元素名 [include]`；`dotAfter` = `元素名 · include` |
| `cppCallGraph.nameFolderTagPick` | `first` | 工作区 | 一条标签模式命中多个目录段时取哪一段：`first` 最靠根 / `deepest` 最靠文件；条目末尾的 `@deepest` / `@first` 优先于本项 |
| `cppCallGraph.excludeFolders` | `[]` | 工作区 | 按目录过滤：命中目录的节点连同子树不在图中显示。写法可混用：相对路径 `third_party`、绝对路径（工作区之外的匹配不到节点）、通配 `**/generated`；整个工作区不会被过滤。资源管理器右键文件夹可添加 / 移除 |

## 通用

扩展取用 VS Code 的 `Call Hierarchy` 接口（`prepareCallHierarchy` / `provideIncomingCalls` / `provideOutgoingCalls`），任何实现该接口的语言服务都可使用。接入新引擎：

1. 确认该语言服务已安装，且能在该语言上提供调用层级。
2. 在 `cppCallGraph.customEngines` 中定义：

   ```jsonc
   "cppCallGraph.customEngines": [
     {
       "id": "my-engine",                          // 唯一标识
       "label": "我的 C/C++ 引擎",                  // 展示名
       "extensionId": "someone.my-engine",        // 判断是否已安装；省略表示不依赖扩展
       "badge": "my-eng",                         // 标签角标文字；省略则不显示
       "matchName": "myEngine",                   // 可选：候选结果的名字含该子串时视为该引擎给出
       "matchDetail": "my-engine",                // 可选：候选结果的详情含该子串时视为该引擎给出
       "advice": "请先安装并启用 My Engine 扩展"   // 可选：该引擎不可用时给出的提示
     }
   ]
   ```

3. 将 `cppCallGraph.languageService` 设为 `custom`，并在 `cppCallGraph.customEngineId` 中填入 `my-engine`。

- `prepareCallHierarchy` 返回所有语言服务的聚合结果，且结果中不含「来自哪个引擎」的字段；因此默认按符号名范围（`selectionRange`）与光标的距离挑选（`enginePickPolicy: nearest`），不会因配置问题查不出结果。
- 需要「只认某个引擎」时，先为该引擎配置 `matchName` 或 `matchDetail`，再把 `enginePickPolicy` 设为 `preferSelected`（认不到时退回就近）或 `onlySelected`（认不到时报告该引擎在此位置无结果）。认领仅在策略不是 `nearest` 时生效。
- 与内置项同 id 的自定义条目会覆盖内置项。
- 填写的引擎 id 不存在时记录一条警告并退回「不指定引擎」。

## 注意事项

- 「展开全部」受 `maxChildrenPerNode` 与 `maxExpandRounds` 约束；「完全展开」不受层数约束。两者均受节点总数上限约束，超出部分不上图并在日志中说明。
- 「被调用关系图」对宏、类型别名、变量等没有调用层级的符号会退回引用查找；退到文本搜索时结果可能包含同名标识符（界面会标注来源）。
