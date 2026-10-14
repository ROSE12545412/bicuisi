# 发布到 GitHub · 操作指引

> 这份是**给你自己看的**操作步骤，不需要提交到仓库（可以留在桌面）。

---

## 一、先看一眼要提交什么

插件本体已完整：**35 个文件 / 约 487 KB**。

```
manifest.json                  酒馆扩展清单（入口）
index.js                       扩展入口：启动 / 事件挂接 / 斜杠命令 / 调试入口
style.css                      全部样式（只碰 bg- 前缀的 class）
README.md                      给用户看的说明
LICENSE                        MIT
.gitignore
.github/workflows/verify.yml   CI：推 tag 或 PR 时自动跑三道检查
assets/beatrice.svg            内置 Q 版立绘（也内联在 floating.js 里）
docs/CONTRACTS.md              模块间接口契约（给改代码的人看）
docs/example-worldbook.json    可直接导入酒馆的示例世界书
scripts/check-syntax.js        加载检查
src/**                         13 个模块
test/**                        454 项单元测试 + 冒烟测试 + 测试运行器
_render/                       浏览器渲染验收页（开发用，不影响发布）
```

**要提交**：上面全部（`_render/` 也留着 —— 它对新贡献者有用，酒馆不会加载它）。
**不要提交**：任何 PNG 截图（已在 `.gitignore` 里排除）。

---

## 二、发布前必做的 2 件事

### 1. 替换作者占位符 `YOUR_NAME`

3 个文件里有占位符。在 **PowerShell** 里执行（把第一行改成你的 GitHub 用户名）：

```powershell
cd "C:\Users\admin\Desktop\骰子\碧翠丝"
$me = "你的GitHub用户名"

# 先预览会被改动的位置，确认没误伤
Select-String -Path "package.json","LICENSE","README.md" -Pattern "YOUR_NAME"

# 执行替换（-Encoding UTF8 保证中文不乱码）
foreach ($f in @("package.json","LICENSE","README.md")) {
    (Get-Content $f -Raw -Encoding UTF8) -replace "YOUR_NAME", $me | Set-Content $f -Encoding UTF8 -NoNewline
}

# 复核：应该没有任何输出
Select-String -Path "package.json","LICENSE","README.md" -Pattern "YOUR_NAME"
```

`manifest.json` 里的 `author` 通常是**显示名**而不是账号名，单独改：

```powershell
(Get-Content manifest.json -Raw -Encoding UTF8) -replace '"author":\s*"YOUR_NAME"', '"author": "你想显示的名字"' | Set-Content manifest.json -Encoding UTF8 -NoNewline
```

### 2. 最终验证

```powershell
cd "C:\Users\admin\Desktop\骰子\碧翠丝"
cmd /c "node scripts/check-syntax.js"
cmd /c "node test/run.js"
cmd /c "node test/smoke-boot.js"
```

三个都应该全绿（13 个模块 / 454 项 / 43 项）。CI 会跑同样的东西。

> ⚠️ 必须用 `cmd /c "..."` 这种形式 —— 如果你的 PowerShell 执行策略禁止运行 `npm.ps1`，
> 直接敲 `npm test` 会报「禁止运行脚本」。

---

## 三、本机有没有装 git

先确认：

```powershell
git --version
```

- **有版本号** → 走第四节
- **提示找不到命令** → 三选一：
  - **装 Git for Windows**（推荐）：https://git-scm.com/download/win ，装完**重开一个 PowerShell 窗口**让 PATH 生效
  - **用 GitHub Desktop**：https://desktop.github.com/ ，图形界面提交推送
  - **网页上传**（最省事）：GitHub 新建空仓库（名字 `beatrice-guide`，**不要**勾 "Add a README file"）→ `Add file` → `Upload files` → 把插件文件夹里**所有文件和文件夹**拖进去
    - ⚠️ `.github` 和 `.gitignore` 是隐藏的，要在文件资源管理器里开启「显示隐藏项目」才能看到并拖入
    - ⚠️ 网页上传对 `.github` 里的 CI 配置不友好（有时会漏），想要 CI 建议还是用 git

---

## 四、命令行发布

```powershell
cd "C:\Users\admin\Desktop\骰子\碧翠丝"

# 1. 初始化
git init
git branch -M main

# 2. 确认忽略规则生效（不该看到任何 .png）
git status --short

# 3. 提交
git add .
git commit -m "feat: 碧翠丝的禁书库 v1.0.0

读世界书线索，用独立辅助 API 生成铺垫式剧情引导与吐槽。
- 独立辅助通道（连接配置 / 酒馆助手 / 直连 / 主连接）
- 正文生成期间并发请求，正文结束立刻出声，用户无等待
- 悬浮窗 Q 版精灵 + 6 种情绪 + 打字机气泡
- 只读标的标签的条目，[禁止引导] 保护剧透
- 相似度去重，避免复读同一条线索
- 454 项单元测试 + 43 项装载冒烟检查"

# 4. 关联远程（换成你自己的地址）
git remote add origin https://github.com/你的用户名/beatrice-guide.git

# 5. 推送
git push -u origin main
```

推送要登录 GitHub。HTTPS 方式需要 **Personal Access Token** 而不是密码：
GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
→ 生成一个带 `Contents: Read and write` 权限的 token，粘贴到密码位置。

---

## 五、别人怎么安装

把 README 里的 `YOUR_NAME` 替换掉之后，两种方式都可用：

**方式一（推荐）** 酒馆 → 扩展 → 安装扩展 → 填：

```
https://github.com/你的用户名/beatrice-guide
```

**方式二** 手动放进 `data/<用户名>/extensions/beatrice-guide/`，刷新页面。

> **TauriTavern 注意**：它的扩展安装器**只接受匿名 http(s) 的 Git 地址** ——
> 不支持 SSH、不支持私有仓库、不支持 zip。所以仓库必须是公开的。

---

## 六、本地改完怎么立刻看到效果

插件是**零依赖、免构建**的 —— 改完代码直接刷新酒馆页面（F5）就生效，不需要任何打包命令。

想直接在本机酒馆里开发（而不是每次复制），用目录联接把仓库「挂」进去：

```powershell
# 先删掉之前复制过去的目录（如果有）
Remove-Item "<你的酒馆目录>\data\default-user\extensions\beatrice-guide" -Recurse -Force

# 建立目录联接（相当于软链接：改仓库 = 改酒馆里的插件）
New-Item -ItemType Junction `
  -Path "<你的酒馆目录>\data\default-user\extensions\beatrice-guide" `
  -Target "C:\Users\admin\Desktop\骰子\碧翠丝"
```

---

## 七、想真机看渲染（可选）

`_render/harness.html` 是一个**不依赖酒馆**的验收页：它在真实浏览器里把插件加载起来，
配一个假的酒馆上下文和一个假的辅助 API，然后把「请求中 → 出声 → 换情绪」三个场景跑一遍。
改 CSS 之后用它比开酒馆快得多。

```powershell
cd "C:\Users\admin\Desktop\骰子\碧翠丝"
cmd /c "node _render/serve.js 8791"
# 然后浏览器打开 http://127.0.0.1:8791/_render/harness.html
```

> ⚠️ 必须走 http，不能直接双击打开 html 文件 ——
> 浏览器在 `file://` 协议下出于 CORS 会拒绝动态 import 本地模块
>（报错：`Failed to fetch dynamically imported module`）。

---

## 八、排查「装到酒馆里没反应」

1. 按 **F12** 看控制台有没有 `[碧翠丝的禁书库]` 开头的日志
   - 看到 `已就绪 v1.0.0` → 正常，问题在配置（看下面第 2 条）
   - 完全没有日志 → 检查 `manifest.json` 是否存在、`js` 字段是否指向 `index.js`
2. 打开 **扩展设置 → 🦋 碧翠丝的禁书库**，看面板底部的**日志区** ——
   不出声的原因会直接写在那里（`本轮不引导：冷却中` / `every-n 未命中` / `通道没选配置`）
3. 点 **🔍 预览命中的线索** —— 一条都没命中说明世界书条目没标标签
4. 点 **🧪 试说一句** —— 真调一次 API，把完整错误摊开给你看
5. 控制台执行 `window.BeatriceGuide.state()` 看完整状态快照
6. 悬浮窗不见了通常是坐标跑到屏幕外：控制台执行
   ```js
   window.BeatriceGuide.settings().ui.avatarPos = { x: 24, y: 220 };
   window.BeatriceGuide.save();
   ```
   然后刷新。

---

## 九、发布检查清单

- [ ] `YOUR_NAME` 已全部替换（`package.json` / `LICENSE` / `README.md`）
- [ ] `manifest.json` 的 `author` 已改成显示名
- [ ] `manifest.json` 与 `package.json` 的 `version` 一致（CI 会校验）
- [ ] 三道检查全绿
- [ ] README 里的仓库地址已替换成真实地址
- [ ] 仓库是**公开**的（TauriTavern 安装器只接受匿名 http(s)）
- [ ] 没有提交任何 PNG 截图
