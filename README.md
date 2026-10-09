# C/C++ 调用关系图

> 许可：MIT ｜ 运行环境：Visual Studio Code 1.75 及以上 ｜ 运行时依赖：无

一个通过 **Vibe coding** 方式开发的 Visual Studio Code 自用扩展，用于在底部面板中以图形方式浏览 C/C++ 函数的调用关系。

扩展通过编辑器右键菜单提供两个查询命令：

- **显示被调用关系** —— 查询谁调用了当前函数
- **显示调用关系** —— 查询当前函数调用了谁

每次查询在面板中新建一个标签页，各标签页可独立关闭；关闭最后一个标签页时，面板视图自动收起。

## 安装

**从 Marketplace / Open VSX 安装**：在扩展面板中搜索 `C/C++ 调用关系图`。

**从本地 VSIX 文件安装**：

```powershell
# 请勿双击 .vsix 文件（Windows 会将其交给 Visual Studio 安装器）
code --install-extension .\cpp-call-graph-<版本>.vsix
```

**也可通过扩展面板**（`Ctrl+Shift+X`）→ 右上角 `...` → `Install from VSIX...` 安装。

安装完成后需重载窗口。随后打开 C/C++ 源文件，将光标置于函数名上并右键即可。

## 前置条件

调用关系数据由 VS Code 的 Call Hierarchy 接口提供，其上游为**本机安装的 C/C++ 语言服务**：

| 语言服务                         | 所需条件                                                                                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **clangd**                 | ① 本机存在`clangd` 可执行文件（clangd 扩展仅为客户端外壳，需另行安装，例如 `winget install LLVM.LLVM`）；② 工程内存在 `compile_commands.json` 或 `compile_flags.txt`。CMake 工程可执行 `cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON` 生成 |
| **C/C++ 扩展（cpptools）** | IntelliSense 完成对工程的解析即可                                                                                                                                                                                                                                |

注意：`clang.exe` 为编译器，不提供调用关系；clangd **扩展**单独安装无效；
必须同时具备 clangd 扩展与 `clangd` 可执行文件。

设置项`cppCallGraph.languageService` 保持 `auto` 时，扩展会自动判断。

## 设置项

| 设置                                | 默认值   | 说明                                               |
| ----------------------------------- | -------- | -------------------------------------------------- |
| `cppCallGraph.languageService`    | `auto` | 语言服务选择：`auto` / `clangd` / `cpptools` |
| `cppCallGraph.maxChildrenPerNode` | `200`  | 同一层级最多显示的结果数量                         |
| `cppCallGraph.autoReveal`         | `true` | 双击方框时是否打开文件并定位                       |
| `cppCallGraph.showEngineWarning`  | `true` | 是否提示两个语言服务同时可用                       |
