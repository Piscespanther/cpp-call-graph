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

| 设置                              | 默认值    | 说明                                                                                                                                                                |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cppCallGraph.languageService`    | `auto`    | 语言服务选择：`auto` / `clangd` / `cpptools` / `any`（不指定引擎）/ `custom`（用 `customEngineId`）                                                                |
| `cppCallGraph.maxChildrenPerNode` | `200`     | 每个方框最多显示的直接调用者 / 被调用者数量。超出部分不显示，悬停提示给出被省略的条数                                                                              |
| `cppCallGraph.maxExpandRounds`    | `5`       | 「展开全部」逐层展开的层数上限；「完全展开」不受该项约束，会展开到没有可展开的节点                                                                                 |
| `cppCallGraph.autoReveal`         | `true`    | 双击方框时打开文件并定位到声明处                                                                                                                                   |
| `cppCallGraph.showEngineWarning`  | `true`    | 检测到两个及以上语言服务可能同时提供调用层级时给出提示                                                                                                             |
| `cppCallGraph.stickyParent`       | `true`    | 纵向滚动时把已展开下一层的方框固定在窗口垂直中央，各自限在自己的子树范围内滑动                                                                                     |
| `cppCallGraph.showLocation`       | `true`    | 方框中显示「文件路径:行号」一行；关闭后仅显示元素名，方框宽度与高度均收窄为单行                                                                                    |
| `cppCallGraph.pathDisplay`        | `tail`    | 路径显示方式：`tail` 保留末尾若干层 / `full` 宽度允许时显示整条路径。完整路径始终可在悬停提示中查看                                                                |
| `cppCallGraph.pathTailLevels`     | `0`       | `tail` 模式下末尾保留的层数（含文件名）；`0` 表示按方框宽度自动                                                                                                    |
| `cppCallGraph.pathAnchors`        | 空        | `tail` 模式下必须显示的目录段，逗号分隔：`目录名` / `目录名+N` / `目录名-N`（以该目录名为基准偏移，只显示偏移后那一段）/ `+N`（从工作区根数）/ `-N`（从文件名往上数）      |
| `cppCallGraph.customEngineId`     | 空        | `languageService` 为 `custom` 时使用的引擎 id                                                                                                                      |
| `cppCallGraph.customEngines`      | `[]`      | 自定义语言服务列表，字段：`id` / `label` / `extensionId` / `badge` / `matchName` / `matchDetail` / `advice`                                                        |
| `cppCallGraph.enginePickPolicy`   | `nearest` | 多引擎时的挑选策略：`nearest` / `preferSelected` / `onlySelected`（后者可能查不出结果）                                                                            |

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
