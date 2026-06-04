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

local function InstallDirect42230PreviewRenderHotfix()
    -- v0.7.3 hotfix:
    -- The inline-preview-render branch previously tried RenderProject_Table and
    -- RenderProject before falling back to action 42230. On some WAV/audio-item
    -- projects those API attempts can leave an empty OGG at the output path; the
    -- fallback then only checks that the file exists and reports success. This
    -- override keeps Capsule's deterministic render settings and track isolation,
    -- but renders directly via Main_OnCommand(42230).
    local OGG_RENDER_CONFIG = "dmdnbwAAAD8AgAAAAIAAAAAgAAAAAAEAAA=="

    local function get_dir(path)
        return tostring(path or ""):match("(.+)\\[^\\]+$") or tostring(path or ""):match("(.+)/[^/]+$") or ""
    end

    local function split_output_path(path)
        local dir = get_dir(path)
        local name = tostring(path or ""):match("[^/\\]+$") or ""
        local base = name:gsub("%.[^%.]+$", "")
        return dir, base, name
    end

    local function make_dir(path)
        if not path or path == "" then return end
        os.execute('if not exist "' .. path:gsub("/", "\\") .. '" mkdir "' .. path:gsub("/", "\\") .. '"')
    end

    local function file_size(path)
        local f = io.open(path, "rb")
        if not f then return 0 end
        local size = f:seek("end") or 0
        f:close()
        return size
    end

    local function get_str(key)
        local _, value = reaper.GetSetProjectInfo_String(0, key, "", false)
        return value or ""
    end

    local function set_str(key, value)
        reaper.GetSetProjectInfo_String(0, key, value or "", true)
    end

    local function get_num(key)
        return reaper.GetSetProjectInfo(0, key, 0, false) or 0
    end

    local function set_num(key, value)
        reaper.GetSetProjectInfo(0, key, value or 0, true)
    end

    local function add_track_to_set(set, track)
        if track and type(track) == "userdata" then
            set[track] = true
        end
    end

    local function add_parent_tracks_to_set(set, track)
        local parent = track and reaper.GetParentTrack(track) or nil
        while parent do
            add_track_to_set(set, parent)
            parent = reaper.GetParentTrack(parent)
        end
    end

    local function add_folder_children_to_set(set, track)
        if not track then return end
        local folder_depth = reaper.GetMediaTrackInfo_Value(track, "I_FOLDERDEPTH")
        if folder_depth ~= 1 then return end
        local start_idx = reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER")
        local depth = 1
        for i = start_idx, reaper.CountTracks(0) - 1 do
            local child = reaper.GetTrack(0, i)
            if not child then break end
            add_track_to_set(set, child)
            depth = depth + reaper.GetMediaTrackInfo_Value(child, "I_FOLDERDEPTH")
            if depth <= 0 then break end
        end
    end

    local function add_send_related_tracks_to_set(set)
        local changed = true
        while changed do
            changed = false
            for track, _ in pairs(set) do
                local send_count = reaper.GetTrackNumSends(track, 0) or 0
                for i = 0, send_count - 1 do
                    local ok, dest = pcall(reaper.GetTrackSendInfo_Value, track, 0, i, "P_DESTTRACK")
                    if ok and dest and type(dest) == "userdata" and not set[dest] then
                        set[dest] = true
                        changed = true
                    end
                end
                local receive_count = reaper.GetTrackNumSends(track, -1) or 0
                for i = 0, receive_count - 1 do
                    local ok, src = pcall(reaper.GetTrackSendInfo_Value, track, -1, i, "P_SRCTRACK")
                    if ok and src and type(src) == "userdata" and not set[src] then
                        set[src] = true
                        changed = true
                    end
                end
            end
        end
    end

    local function build_selected_item_render_track_set()
        local set = {}
        for i = 0, reaper.CountSelectedMediaItems(0) - 1 do
            local item = reaper.GetSelectedMediaItem(0, i)
            local track = item and reaper.GetMediaItemTrack(item) or nil
            add_track_to_set(set, track)
            add_parent_tracks_to_set(set, track)
            add_folder_children_to_set(set, track)
        end
        add_send_related_tracks_to_set(set)
        return set
    end

    local function capture_project_state()
        local state = { strings = {}, numbers = {}, tracks = {}, items = {} }
        local string_keys = { "RENDER_FILE", "RENDER_PATTERN", "RENDER_FORMAT", "RENDER_FORMAT2", "RENDER_METADATA", "RENDER_TARGETS" }
        local number_keys = {
            "RENDER_RANGE", "RENDER_SETTINGS", "RENDER_BOUNDSFLAG", "RENDER_STEMS", "RENDER_1X", "RENDER_SRATE",
            "RENDER_CHANNELS", "RENDER_TAILFLAG", "RENDER_TAILMS", "RENDER_ADDTOPROJ", "RENDER_DITHER", "RENDER_TRIM",
            "RENDER_FADEIN", "RENDER_FADEOUT", "RENDER_NORMALIZE", "RENDER_NORMALIZE_TARGET", "RENDER_BRICKWALL"
        }
        for _, key in ipairs(string_keys) do state.strings[key] = get_str(key) end
        for _, key in ipairs(number_keys) do state.numbers[key] = get_num(key) end
        state.time_start, state.time_end = reaper.GetSet_LoopTimeRange(false, false, 0, 0, false)
        state.loop_start, state.loop_end = reaper.GetSet_LoopTimeRange(false, true, 0, 0, false)
        state.cursor = reaper.GetCursorPosition()
        for i = 0, reaper.CountTracks(0) - 1 do
            local track = reaper.GetTrack(0, i)
            if track then
                local ok, chunk = reaper.GetTrackStateChunk(track, "", false)
                table.insert(state.tracks, { track = track, chunk = ok and chunk or nil, solo = reaper.GetMediaTrackInfo_Value(track, "I_SOLO"), mute = reaper.GetMediaTrackInfo_Value(track, "B_MUTE") })
            end
        end
        for ti = 0, reaper.CountTracks(0) - 1 do
            local track = reaper.GetTrack(0, ti)
            if track then
                for ii = 0, reaper.CountTrackMediaItems(track) - 1 do
                    local item = reaper.GetTrackMediaItem(track, ii)
                    if item then
                        table.insert(state.items, { item = item, selected = reaper.IsMediaItemSelected(item) })
                    end
                end
            end
        end
        return state
    end

    local function restore_project_state(state)
        if not state then return end
        reaper.PreventUIRefresh(1)
        for _, entry in ipairs(state.tracks or {}) do
            if entry.track then
                if entry.chunk then
                    pcall(reaper.SetTrackStateChunk, entry.track, entry.chunk, false)
                else
                    pcall(reaper.SetMediaTrackInfo_Value, entry.track, "I_SOLO", entry.solo or 0)
                    pcall(reaper.SetMediaTrackInfo_Value, entry.track, "B_MUTE", entry.mute or 0)
                end
            end
        end
        for _, entry in ipairs(state.items or {}) do
            if entry.item then
                pcall(reaper.SetMediaItemSelected, entry.item, entry.selected == true)
            end
        end
        for key, value in pairs(state.strings or {}) do pcall(set_str, key, value) end
        for key, value in pairs(state.numbers or {}) do pcall(set_num, key, value) end
        pcall(reaper.GetSet_LoopTimeRange, true, false, state.time_start or 0, state.time_end or 0, false)
        pcall(reaper.GetSet_LoopTimeRange, true, true, state.loop_start or 0, state.loop_end or 0, false)
        if state.cursor then pcall(reaper.SetEditCurPos, state.cursor, false, false) end
        pcall(reaper.UpdateArrange)
        reaper.PreventUIRefresh(-1)
    end

    local function apply_inline_preview_track_isolation(track_set)
        local selected_count = 0
        for _ in pairs(track_set or {}) do selected_count = selected_count + 1 end
        if selected_count == 0 then return 0 end
        for i = 0, reaper.CountTracks(0) - 1 do
            local track = reaper.GetTrack(0, i)
            if track then reaper.SetMediaTrackInfo_Value(track, "I_SOLO", 0) end
        end
        for track, _ in pairs(track_set) do
            reaper.SetMediaTrackInfo_Value(track, "B_MUTE", 0)
            reaper.SetMediaTrackInfo_Value(track, "I_SOLO", 2)
        end
        return selected_count
    end

    local function diag(event, fields)
        if diagnostic_logger and diagnostic_logger.write then
            pcall(diagnostic_logger.write, event, fields or {})
        end
    end

    RenderPreviewAudioFromCurrentProject = function(outputPath, startTime, endTime, hasMidiItems)
        local previewStartTime, previewEndTime = startTime, endTime
        local renderDir, renderBase = split_output_path(outputPath)
        if renderDir == "" or renderBase == "" then
            return false
        end
        make_dir(renderDir)
        os.remove(outputPath)

        local state = capture_project_state()
        local track_set = build_selected_item_render_track_set()
        local isolated_count = 0
        local renderOk = false
        local renderRet = ""

        local ok, err = pcall(function()
            BridgePhase("rendering preview: preparing current project")
            reaper.PreventUIRefresh(1)
            isolated_count = apply_inline_preview_track_isolation(track_set)
            reaper.PreventUIRefresh(-1)

            reaper.GetSet_LoopTimeRange(true, false, previewStartTime, previewEndTime, false)
            reaper.GetSet_LoopTimeRange(true, true, previewStartTime, previewEndTime, false)
            set_str("RENDER_FILE", renderDir)
            set_str("RENDER_PATTERN", renderBase)
            set_str("RENDER_FORMAT", OGG_RENDER_CONFIG)
            set_num("RENDER_RANGE", 1)
            set_num("RENDER_BOUNDSFLAG", 2)
            set_num("RENDER_STEMS", 0)
            set_num("RENDER_1X", hasMidiItems and 2 or 0)
            set_num("RENDER_SETTINGS", 0)
            set_num("RENDER_TAILFLAG", 0)
            set_num("RENDER_TAILMS", 0)
            set_num("RENDER_ADDTOPROJ", 0)
            set_num("RENDER_DITHER", 0)
            set_num("RENDER_TRIM", 0)
            set_num("RENDER_FADEIN", 0)
            set_num("RENDER_FADEOUT", 0)
            set_num("RENDER_NORMALIZE", 0)
            set_num("RENDER_NORMALIZE_TARGET", 0)
            set_num("RENDER_BRICKWALL", 0)
            reaper.UpdateArrange()

            diag("inline_render_settings_applied", {
                output = tostring(outputPath or ""),
                render_file = tostring(renderDir or ""),
                render_pattern = tostring(renderBase or ""),
                boundsflag = tostring(get_num("RENDER_BOUNDSFLAG")),
                start_time = tostring(previewStartTime),
                end_time = tostring(previewEndTime),
                direct_42230 = "true",
                skipped_renderproject_api = "true"
            })

            BridgePhase("rendering preview: rendering current project")
            os.remove(outputPath)
            reaper.Main_OnCommand(42230, 0)
            local size = file_size(outputPath)
            renderOk = size > 0
            renderRet = "direct_42230; output_size=" .. tostring(size)
            diag("inline_render_api_result", {
                method = "direct_Main_OnCommand_42230",
                result = renderRet,
                output = tostring(outputPath or ""),
                isolated_tracks = tostring(isolated_count)
            })
        end)

        restore_project_state(state)

        if not ok then
            diag("inline_render_api_failed", { method = "direct_Main_OnCommand_42230", error = tostring(err or ""), isolated_tracks = tostring(isolated_count) })
            return false
        end
        if not renderOk then
            diag("inline_render_api_failed", { method = "direct_Main_OnCommand_42230", last_result = renderRet, output = tostring(outputPath or ""), isolated_tracks = tostring(isolated_count) })
            return false
        end
        return true
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

    InstallDirect42230PreviewRenderHotfix()
    Log("✓ 已启用 direct 42230 preview render hotfix\n")

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