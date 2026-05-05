-- [Windows 自动导出] 从配置文件读取参数并执行导出
-- 用途: 通过 -nonewinst 参数在当前 REAPER 实例中执行
-- 注意: 此脚本专门为 Windows 平台设计，与 Mac 版本分离

-- 全局标志：防止重复执行
if _SYNEST_EXPORT_RUNNING then
    return
end
_SYNEST_EXPORT_RUNNING = true

-- 禁用控制台输出（避免弹出 REAPER 控制台窗口）
-- 调试时可设为 true
local ENABLE_CONSOLE = false

local function Log(msg)
    if ENABLE_CONSOLE then
        reaper.ShowConsoleMsg(msg)
    end
end

-- 获取 Windows 临时目录
local function GetTempDir()
    local temp = os.getenv("TEMP") or os.getenv("TMP") or "C:\\Temp"
    return temp .. "\\synest_export"
end

local TEMP_DIR = GetTempDir()

local function LoadConfig()
    -- Windows 路径
    local config_path = TEMP_DIR .. "\\webui_export_config.json"
    -- 也尝试正斜杠版本
    local config_path_alt = config_path:gsub("\\", "/")
    
    Log("尝试加载配置: " .. config_path .. "\n")
    local file = io.open(config_path, "r")
    
    if not file then
        Log("尝试替代路径: " .. config_path_alt .. "\n")
        file = io.open(config_path_alt, "r")
    end

    if not file then
        return nil, "无法打开配置文件: " .. config_path
    end

    local content = file:read("*a")
    file:close()
    Log("配置内容: " .. content .. "\n")

    -- 解析 JSON
    local project_name = content:match('"project_name"%s*:%s*"([^"]*)"')
    local theme_name = content:match('"theme_name"%s*:%s*"([^"]*)"')
    local render_preview_str = content:match('"render_preview"%s*:%s*(true)')
    local capsule_type = content:match('"capsule_type"%s*:%s*"([^"]*)"')
    local username = content:match('"username"%s*:%s*"([^"]*)"')
    local export_dir = content:match('"export_dir"%s*:%s*"([^"]*)"')

    if not project_name or not theme_name then
        return nil, "配置文件格式错误"
    end

    local render_preview = render_preview_str == "true"

    local config = {
        project_name = project_name,
        theme_name = theme_name,
        render_preview = render_preview,
        capsule_type = capsule_type or "magic",
        username = username or "user",
        export_dir = export_dir
    }

    return config
end

local function WriteResult(success, capsule_name, error_msg)
    local result_path = TEMP_DIR .. "\\export_result.json"
    
    -- 确保目录存在
    os.execute('if not exist "' .. TEMP_DIR .. '" mkdir "' .. TEMP_DIR .. '"')
    
    local result_file = io.open(result_path, "w")
    if not result_file then
        -- 尝试正斜杠版本
        result_path = result_path:gsub("\\", "/")
        result_file = io.open(result_path, "w")
    end

    Log("写入结果到: " .. result_path .. "\n")

    if result_file then
        if success then
            local content = string.format('{"success": true, "capsule_name": "%s"}', capsule_name)
            result_file:write(content)
            Log("写入成功: " .. content .. "\n")
        else
            local content = string.format('{"success": false, "error": "%s"}', error_msg or "未知错误")
            result_file:write(content)
            Log("写入失败信息: " .. content .. "\n")
        end
        result_file:close()
    else
        Log("错误: 无法打开结果文件!\n")
    end
end

local function Main()
    Log("=== [Windows 自动导出脚本启动] ===\n")
    Log("时间戳: " .. os.date("%Y-%m-%d %H:%M:%S") .. "\n")
    Log("临时目录: " .. TEMP_DIR .. "\n")

    -- 1. 读取配置
    Log("步骤 1: 读取配置文件...\n")
    local config, err = LoadConfig()
    if not config then
        Log("配置错误: " .. err .. "\n")
        WriteResult(false, nil, err)
        return
    end
    Log("✓ 配置读取成功\n")

    -- 2. 检查选中的 Items
    Log("步骤 2: 检查选中的 Items...\n")
    local num_items = reaper.CountSelectedMediaItems(0)
    Log("  选中的 Items 数量: " .. num_items .. "\n")

    if num_items == 0 then
        Log("错误: 没有选中的 Items\n")
        -- 先写入结果文件（让后端尽快返回，不阻塞）
        WriteResult(false, nil, "没有选中的 Items")
        -- 再在 REAPER 中弹窗提示用户
        reaper.ShowMessageBox(
            "请先选中要导出的音频 Items\n\n" ..
            "操作方法：\n" ..
            "1. 在 REAPER 中选择一个或多个音频 Items\n" ..
            "2. 然后再次点击保存胶囊",
            "Sound Capsule - 没有选中的 Items",
            0  -- 0 = OK 按钮
        )
        return
    end

    -- 3. 设置全局变量
    Log("步骤 3: 设置全局变量...\n")
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
        export_dir = config.export_dir
    }
    Log("  胶囊名称: " .. capsule_name .. "\n")
    Log("  导出目录: " .. tostring(config.export_dir) .. "\n")

    -- 4. 加载主导出脚本 (Windows 版本)
    Log("步骤 4: 加载主导出脚本...\n")
    
    local script_path = debug.getinfo(1).source:match("@(.*)$")
    local script_dir = script_path:match("(.+)\\") or script_path:match("(.+)/") or ""
    
    -- 尝试多个可能的路径
    local main_scripts = {
        script_dir .. "main_export2_windows.lua",
        script_dir .. "\\main_export2_windows.lua",
        script_dir .. "/main_export2_windows.lua",
        script_dir .. "main_export2.lua",  -- 回退到通用版本
    }
    
    local main_export_func = nil
    for _, main_script in ipairs(main_scripts) do
        Log("  尝试: " .. main_script .. "\n")
        main_export_func = loadfile(main_script)
        if main_export_func then
            Log("  ✓ 成功加载: " .. main_script .. "\n")
            break
        end
    end

    if not main_export_func then
        local error_msg = "无法加载主导出脚本"
        Log("✗ " .. error_msg .. "\n")
        WriteResult(false, nil, error_msg)
        return
    end

    -- 5. 执行导出
    Log("步骤 5: 执行导出...\n")
    
    -- 用 pcall 包裹脚本加载，捕获语法错误
    local load_success, load_err = pcall(main_export_func)
    if not load_success then
        local error_msg = "加载脚本失败: " .. tostring(load_err)
        Log("✗ " .. error_msg .. "\n")
        WriteResult(false, nil, error_msg)
        return
    end
    Log("✓ 脚本加载完成\n")

    -- 用 pcall 执行 main 函数
    Log("调用 main() 函数...\n")
    local success, result = pcall(main)
    Log("main() 返回: success=" .. tostring(success) .. ", result=" .. tostring(result) .. "\n")

    if success then
        if result == true then
            Log("✓ 导出成功: " .. _SYNEST_AUTO_EXPORT.capsule_name .. "\n")
            WriteResult(true, _SYNEST_AUTO_EXPORT.capsule_name, nil)
        else
            -- main() 返回 false 表示导出失败（如没有选中 item）
            Log("✗ main() 返回 false，导出失败\n")
            WriteResult(false, nil, "导出失败：请先在 REAPER 中选中至少一个 Audio Item")
        end
    else
        local error_msg = "main() 执行异常: " .. tostring(result)
        Log("✗ " .. error_msg .. "\n")
        WriteResult(false, nil, error_msg)
    end
    
    Log("=== [Windows 自动导出完成] ===\n")
end

Main()
