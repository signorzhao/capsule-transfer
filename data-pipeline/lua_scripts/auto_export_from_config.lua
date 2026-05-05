-- [自动导出] 从配置文件读取参数并执行导出
-- 用途: 通过 -nonewinst 参数在当前 REAPER 实例中执行

-- 全局标志：防止重复执行
if _SYNEST_EXPORT_RUNNING then
    -- 已经在运行，直接返回
    return
end
_SYNEST_EXPORT_RUNNING = true

-- 禁用控制台输出（自动导出模式下不需要显示控制台）
local ENABLE_CONSOLE = false

-- 包装函数：根据开关决定是否显示控制台消息
local function Log(msg)
    if ENABLE_CONSOLE then
        reaper.ShowConsoleMsg(msg)
    end
end

local function LoadConfig()
    -- 从配置文件读取导出参数
    local config_path = "/tmp/synest_export/webui_export_config.json"
    local file = io.open(config_path, "r")

    if not file then
        return nil, "无法打开配置文件: " .. config_path
    end

    local content = file:read("*a")
    file:close()

    -- 解析 JSON (使用简单的模式匹配)
    local project_name = content:match('"project_name"%s*:%s*"([^"]*)"')
    local theme_name = content:match('"theme_name"%s*:%s*"([^"]*)"')
    local render_preview_str = content:match('"render_preview"%s*:%s*(true)')
    local capsule_type = content:match('"capsule_type"%s*:%s*"([^"]*)"')
    local username = content:match('"username"%s*:%s*"([^"]*)"')
    local export_dir = content:match('"export_dir"%s*:%s*"([^"]*)"')

    if not project_name or not theme_name then
        return nil, "配置文件格式错误"
    end

    -- 转换为布尔值 (默认为 false)
    local render_preview = false
    if render_preview_str == "true" then
        render_preview = true
    end

    local config = {
        project_name = project_name,
        theme_name = theme_name,
        render_preview = render_preview,
        capsule_type = capsule_type or "magic",
        username = username or "user"
    }

    -- 如果配置中指定了导出目录，保存到全局变量
    if export_dir and export_dir ~= "" and export_dir ~= "null" then
        config.export_dir = export_dir
        Log("=== [路径配置信息] ===\n")
        Log("导出目录: " .. export_dir .. "\n")
        Log("路径类型: " .. (export_dir:match("^/") and "绝对路径 (Unix)" or "相对路径/其他") .. "\n")
        Log("=======================\n")
    else
        Log("⚠️  未配置导出目录，将使用默认路径\n")
    end

    return config
end

local function WriteResult(success, capsule_name, error_msg)
    local result_path = "/tmp/synest_export/export_result.json"
    local result_file = io.open(result_path, "w")

    Log("=== [WriteResult] 开始写入结果文件 ===\n")
    Log("  路径: " .. result_path .. "\n")
    Log("  success: " .. tostring(success) .. "\n")
    Log("  capsule_name: " .. tostring(capsule_name) .. "\n")
    Log("  error_msg: " .. tostring(error_msg) .. "\n")
    Log("  result_file: " .. tostring(result_file) .. "\n")

    if result_file then
        if success then
            local content = string.format('{"success": true, "capsule_name": "%s"}', capsule_name)
            result_file:write(content)
            Log("  ✓ 写入成功: " .. content .. "\n")
        else
            local msg = error_msg or "未知错误"
            if type(msg) ~= "string" then msg = tostring(msg) end
            msg = msg:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"):gsub("\r", "\\r")
            local content = string.format('{"success": false, "error": "%s"}', msg)
            result_file:write(content)
            Log("  ✓ 写入失败信息: " .. content .. "\n")
        end
        result_file:close()
        Log("  ✓ 文件已关闭\n")
    else
        Log("  ✗ 无法打开文件进行写入!\n")
    end
    Log("=====================================\n")
end

local function Main()
    -- 立即输出日志,证明脚本已开始执行
    Log("=== [自动导出脚本启动] ===\n")
    Log("时间戳: " .. os.date("%Y-%m-%d %H:%M:%S") .. "\n")
    Log("脚本路径: " .. debug.getinfo(1).source:match("@(.*)$") .. "\n")
    Log("运行标志状态: " .. tostring(_SYNEST_EXPORT_RUNNING) .. "\n")

    -- 缓存当前工程路径，供 macOS 回退命令行（reaper -nonewinst project.rpp script.lua）使用
    local _, project_path = reaper.EnumProjects(-1, "")
    if project_path and project_path ~= "" then
        local cache_dir = "/tmp/synest_export"
        os.execute("mkdir -p " .. cache_dir)
        local cache_file = io.open(cache_dir .. "/current_project_path.txt", "w")
        if cache_file then
            cache_file:write(project_path)
            cache_file:close()
        end
    end

    -- 1. 读取配置
    Log("步骤 1: 读取配置文件...\n")
    local config, err = LoadConfig()
    if not config then
        Log("配置错误: " .. err .. "\n")
        WriteResult(false, nil, err)
        return
    end
    Log("✓ 配置读取成功\n")
    Log("  项目名: " .. config.project_name .. "\n")
    Log("  主题名: " .. config.theme_name .. "\n")

    -- 2. 检查选中的 Items
    Log("步骤 2: 检查选中的 Items...\n")
    local num_items = reaper.CountSelectedMediaItems(0)
    Log("  选中的 Items 数量: " .. num_items .. "\n")

    if num_items == 0 then
        local error_msg = "没有选中的 Items。请在 REAPER 中选中要导出的音频 Items"
        Log(error_msg .. "\n")
        WriteResult(false, nil, "没有选中的 Items")
        return
    end

    -- 3. 设置全局变量供主脚本使用
    Log("步骤 3: 设置全局变量...\n")

    -- 生成胶囊名称: 胶囊类型_用户名_时间戳
    local capsule_type = config.capsule_type or "magic"
    local username = config.username or "user"
    local timestamp = os.date("%Y%m%d_%H%M%S")
    local capsule_name = capsule_type .. "_" .. username .. "_" .. timestamp

    _SYNEST_AUTO_EXPORT = {
        project_name = config.project_name,
        theme_name = config.theme_name,
        render_preview = config.render_preview,
        capsule_type = capsule_type,
        capsule_name = capsule_name,
        export_dir = config.export_dir  -- 添加导出目录
    }
    Log("✓ 全局变量已设置\n")
    Log("  胶囊类型: " .. capsule_type .. "\n")
    Log("  用户名: " .. username .. "\n")
    Log("  胶囊名称: " .. capsule_name .. "\n")
    if config.export_dir then
        Log("  导出目录: " .. config.export_dir .. "\n")
    end

    -- 4. 加载并执行主导出脚本
    Log("步骤 4: 加载主导出脚本...\n")

    -- 找到脚本路径 (相对于当前脚本)
    local script_path = debug.getinfo(1).source:match("@(.*)$")
    local script_dir = script_path:match("(.*[/\\])")
    local main_script = script_dir .. "main_export2.lua"
    Log("  主脚本路径: " .. main_script .. "\n")

    -- 尝试加载
    local main_export_func, load_err = loadfile(main_script)
    if not main_export_func then
        Log("  相对路径加载失败，尝试绝对路径...\n")
        -- 尝试绝对路径
        local alt_path = "/Users/ianzhao/Desktop/Sound_Capsule/synesth/data-pipeline/lua_scripts/main_export2.lua"
        Log("  绝对路径: " .. alt_path .. "\n")
        main_export_func = loadfile(alt_path)

        if not main_export_func then
            local error_msg = "无法加载主导出脚本: " .. (load_err or "未知错误")
            Log("✗ " .. error_msg .. "\n")
            WriteResult(false, nil, error_msg)
            return
        end
    end
    Log("✓ 主脚本加载成功\n")

    -- 5. 执行导出
    -- 主脚本会读取 _SYNEST_AUTO_EXPORT 全局变量
    Log("步骤 5: 开始执行导出...\n")

    -- 执行加载的 chunk（这会定义 main 函数）
    -- 注意：chunk 执行时，由于 `if ... == nil` 检查，main() 不会被自动调用
    main_export_func()

    -- 捕获所有返回值
    Log("=== [pcall 调用前] ===\n")
    Log("  _SYNEST_AUTO_EXPORT.capsule_name: " .. tostring(_SYNEST_AUTO_EXPORT.capsule_name) .. "\n")
    Log("======================\n")

    -- 调用 main 函数并捕获返回值（main 可能返回 true 或 false, error_msg）
    local ok, r1, r2 = pcall(main)

    Log("=== [pcall 返回后] ===\n")
    Log("  ok: " .. tostring(ok) .. "\n")
    Log("  r1: " .. tostring(r1) .. "\n")
    Log("  r2: " .. tostring(r2) .. "\n")
    Log("=======================\n")

    if ok then
        if r1 == true then
            Log("✓ 导出执行完成\n")
            Log("  准备调用 WriteResult，capsule_name: " .. tostring(_SYNEST_AUTO_EXPORT.capsule_name) .. "\n")
            WriteResult(true, _SYNEST_AUTO_EXPORT.capsule_name, nil)
            Log("✓ 导出成功! 胶囊: " .. _SYNEST_AUTO_EXPORT.capsule_name .. "\n")
            Log("=== [自动导出完成] ===\n")
        else
            local errMsg = (type(r2) == "string" and r2 ~= "") and r2 or "导出失败（未返回具体原因）"
            Log("✗ 导出执行失败（返回 false）\n")
            Log("  错误信息: " .. errMsg .. "\n")
            WriteResult(false, nil, errMsg)
        end
    else
        Log("✗ 导出执行失败（异常）\n")
        Log("  错误信息: " .. tostring(r1) .. "\n")
        WriteResult(false, nil, tostring(r1))
    end

    -- 清理全局变量
    _SYNEST_AUTO_EXPORT = nil

    -- 清理运行标志，允许下次导出
    _SYNEST_EXPORT_RUNNING = nil
end

-- 确保脚本在主线程执行
reaper.defer(Main)
