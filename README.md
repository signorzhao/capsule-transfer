# Capsule Transfer

局域网内的胶囊点对点收发工具。支持从 Reaper 捕获工程素材，打包为胶囊并发送给局域网内的其他设备。

- **不依赖** Supabase / 任何云服务
- **不需要** 用户登录 / JWT
- 功能：**本地胶囊库**、**从 Reaper 捕获**、**向指定 IP 发送**、**接收他人胶囊到本机**

---

## 项目结构

```
capsule-transfer/
├── server/                 # Python Flask 后端
│   ├── app.py              # 入口
│   ├── db.py               # SQLite 访问层
│   ├── schema.sql          # 表结构（capsules / contacts / transfers）
│   ├── bundle.py           # 胶囊打包 / 解包（zip）
│   ├── net.py              # 本机网络信息
│   └── requirements.txt
├── webapp/                 # Vite + React + Tailwind 前端
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api.js
│   │   └── components/
│   └── package.json
├── data-pipeline/          # Reaper 导出依赖
│   ├── common.py           # PathManager
│   ├── exporters/          # WebUI 导出逻辑
│   ├── lua_scripts/        # Reaper Lua 脚本
│   └── scripts/            # macOS 后台渲染助手（Swift）
└── scripts/
    ├── start_server.sh
    └── start_webapp.sh
```

## 快速开始

### 1. 启动后端

```bash
bash scripts/start_server.sh   # 默认 http://0.0.0.0:5005
```

首次会自动创建 `.venv` 并安装 `Flask / flask-cors / requests`。

### 2. 启动前端

```bash
bash scripts/start_webapp.sh   # 默认 http://localhost:3100
```

首次会执行 `npm install`。前端在顶栏显示 **本机名称 · IP:端口**，把这串告诉对方即可。

### 3. macOS 后台渲染（可选）

如果需要在捕获时生成 OGG 预览且不弹出 Reaper 窗口，编译 Swift 助手：

```bash
swiftc -O -o data-pipeline/scripts/render_background_mac data-pipeline/scripts/render_background_mac.swift
```

### 4. 双机收发

1. **A 机**：在"库"页点击 **新捕获** 从 Reaper 生成胶囊，或导入 `.capsule.zip`。
2. **A 机**：进入"发送"页 → 选目标（联系人 / 临时 IP） → 选胶囊 → **立即发送**。
3. **B 机**：胶囊会出现在"库"页，并标注来源。

## 主要 API

| Method | Path                          | 说明                         |
| ------ | ----------------------------- | ---------------------------- |
| GET    | `/api/health`                 | 健康检查                     |
| GET    | `/api/network/info`           | 本机 IP / 端口 / 主机名      |
| GET    | `/api/capsules`               | 胶囊列表                     |
| POST   | `/api/capsules`               | 创建胶囊（zip 或 source_dir）|
| POST   | `/api/capsules/webui-export`  | 从 Reaper 捕获胶囊           |
| DELETE | `/api/capsules/:id`           | 删除胶囊（含文件）           |
| GET    | `/api/capsules/:id/bundle`    | 下载该胶囊的 zip 包          |
| GET    | `/api/contacts`               | 联系人列表                   |
| POST   | `/api/contacts`               | 添加 / 更新联系人            |
| POST   | `/api/p2p/send`               | 发送本地胶囊给指定 IP        |
| POST   | `/api/p2p/import`             | （对方调用）接收胶囊         |
| GET    | `/api/transfers`              | 收发历史                     |

## 安全提示

- **仅在你信任的局域网中运行**；服务默认监听 `0.0.0.0`。
- 可在 `.env` 设置 `LAN_CAPSULE_SHARED_TOKEN`：双方需带相同 `X-Capsule-Token` 请求头才能完成传输。
- 系统防火墙可能需要放行后端端口（默认 `5005`）。

## 系统要求

- Python 3.10+
- Node.js 18+
- REAPER（用于胶囊捕获，需开启 Web Interface 端口 9000）
