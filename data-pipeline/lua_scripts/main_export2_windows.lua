-- Reaper Sonic Capsule
-- 主导出脚本
--
-- 功能：将选中的 Audio Item(s) 打包为独立的资产胶囊
-- 包含：精简的 RPP 工程、预览音频、JSON 元数据

-- 全局变量：控制控制台输出
-- 设为 false 避免弹出 REAPER 控制台窗口，调试时可设为 true
local ENABLE_CONSOLE = false
local MAX_PREVIEW_SECONDS = 60

-- 保存原始的 ShowConsoleMsg 函数
local _original_ShowConsoleMsg = reaper.ShowConsoleMsg

-- 包装函数：根据全局变量决定是否显示
function Log(msg)
    if ENABLE_CONSOLE then
        _original_ShowConsoleMsg(msg)
    end
end

local function BridgePhase(msg)
    if reaper and reaper.SetExtState then
        reaper.SetExtState("capsule_transfer", "export_phase", tostring(msg or ""), false)
    end
end

-- 直接覆盖 reaper.ShowConsoleMsg，让所有调用都受 ENABLE_CONSOLE 控制
function reaper.ShowConsoleMsg(msg)
    if ENABLE_CONSOLE then
        _original_ShowConsoleMsg(msg)
    end
end

-- ============================================================
-- Windows 专用：跨平台辅助函数
-- ============================================================

-- 检测操作系统
local function IsWindows()
    local sep = package.config:sub(1,1)
    return sep == "\\"
end

-- 跨平台获取目录路径（同时支持 / 和 \）
local function GetDirectoryPath(filePath)
    if not filePath or filePath == "" then
        return ""
    end
    -- 先尝试 Windows 风格 \，再尝试 Unix 风格 /
    local dir = string.match(filePath, "(.+)\\[^\\]+$") or string.match(filePath, "(.+)/[^/]+$") or ""
    return dir
end

local function GetCurrentScriptDir()
    local src = debug.getinfo(1).source or ""
    local path = src:match("@(.*)$") or src
    return GetDirectoryPath(path)
end

-- 跨平台路径拼接
local function JoinPath(base, ...)
    if not base or base == "" then
        return ""
    end
    
    local sep = "/"
    if IsWindows() then
        sep = "\\"
    end
    
    local result = base
    for _, part in ipairs({...}) do
        if part and part ~= "" then
            part = string.gsub(part, "^[/\\]+", "")
            result = string.gsub(result, "[/\\]+$", "")
            result = result .. sep .. part
        end
    end
    return result
end

local function RunCommandHidden(command, timeoutMs)
    if reaper.ExecProcess then
        local ok, result = pcall(reaper.ExecProcess, command, timeoutMs or 190000)
        if ok then
            return result
        end
    end
    return os.execute(command)
end

local MakeDir

local function PathExists(path)
    if not path or path == "" then
        return false
    end
    local f = io.open(path, "rb")
    if f then
        f:close()
        return true
    end
    return false
end

local function QuoteWindowsArg(value)
    return '"' .. tostring(value or ""):gsub('"', '""') .. '"'
end

local function WriteTempWindowsRenderHelper(helperDir)
    if not helperDir or helperDir == "" then
        return nil
    end
    MakeDir(helperDir)
    local helperPath = JoinPath(helperDir, "_capsule_render_background_" .. tostring(os.time()) .. ".vbs")
    local f = io.open(helperPath, "w")
    if not f then
        return nil
    end
    f:write([[Option Explicit

Dim shell, reaperExe, rppPath, cmd

If WScript.Arguments.Count < 2 Then
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
reaperExe = WScript.Arguments.Item(0)
rppPath = WScript.Arguments.Item(1)
shell.Environment("PROCESS")("CAPSULE_TRANSFER_BRIDGE_DISABLED") = "1"

cmd = """" & reaperExe & """ -renderproject """ & rppPath & """ -nosplash -ignoreerrors -close"

WScript.Quit shell.Run(cmd, 7, True)
]])
    f:close()
    return helperPath
end

local function RunWindowsBackgroundRender(reaperPath, rppPath, helperDir, timeoutMs)
    local winRppPath = tostring(rppPath or ""):gsub("/", "\\")
    local helperPath = WriteTempWindowsRenderHelper(helperDir)
    if helperPath and PathExists(helperPath) then
        local renderCmd = string.format(
            'wscript.exe //B //Nologo %s %s %s',
            QuoteWindowsArg(helperPath),
            QuoteWindowsArg(reaperPath),
            QuoteWindowsArg(winRppPath)
        )
        reaper.ShowConsoleMsg("渲染命令: " .. renderCmd .. "\n")
        local result = RunCommandHidden(renderCmd, timeoutMs or 190000)
        os.remove(helperPath)
        return result
    end

    local fallbackCmd = string.format(
        '%s -renderproject %s -nosplash -ignoreerrors -close',
        QuoteWindowsArg(reaperPath),
        QuoteWindowsArg(winRppPath)
    )
    reaper.ShowConsoleMsg("渲染命令 fallback: " .. fallbackCmd .. "\n")
    return RunCommandHidden(fallbackCmd, timeoutMs or 190000)
end

local function QuoteRppValue(value)
    value = tostring(value or ""):gsub("\\", "/"):gsub('"', '\\"')
    return '"' .. value .. '"'
end

local function RewriteRppRenderOutputToCurrentDir(rppPath, renderPattern)
    if not rppPath or rppPath == "" then
        return false
    end
    local rppDir = GetDirectoryPath(rppPath)
    if not rppDir or rppDir == "" then
        return false
    end
    local f = io.open(rppPath, "r")
    if not f then
        return false
    end
    local content = f:read("*a") or ""
    f:close()

    local normalizedDir = rppDir:gsub("\\", "/")

    -- REAPER may keep render settings with indentation or quoted paths. Remove
    -- every existing project-level render output line before inserting the
    -- capsule-local directory, otherwise -renderproject can write to a stale
    -- portable folder saved inside the RPP.
    content = content:gsub("[ \t]*RENDER_FILE%s+[^\n\r]*[\r]?\n", "")
    content = content:gsub("[ \t]*RENDER_FILE%s+[^\n\r]*$", "")
    content = content:gsub("[ \t]*RENDER_PATTERN%s+[^\n\r]*[\r]?\n", "")
    content = content:gsub("[ \t]*RENDER_PATTERN%s+[^\n\r]*$", "")

    local settings = string.format("RENDER_FILE %s\nRENDER_PATTERN %s\n", QuoteRppValue(normalizedDir), QuoteRppValue(renderPattern or ""))
    local replaced = false
    content = content:gsub("(<REAPER_PROJECT[^\n\r]*[\r]?\n)", function(header)
        replaced = true
        return header .. settings
    end, 1)
    if not replaced then
        content = settings .. content
    end

    local wf = io.open(rppPath, "w")
    if not wf then
        return false
    end
    wf:write(content)
    wf:close()
    reaper.ShowConsoleMsg("✓ RPP渲染输出目录已更新: " .. normalizedDir .. "\n")
    return true
end

-- 跨平台创建目录（递归创建）
MakeDir = function(path)
    if not path or path == "" then
        return false
    end
    
    if IsWindows() then
        local winPath = path:gsub("/", "\\")
        local cmd = string.format('if not exist "%s" mkdir "%s"', winPath, winPath)
        os.execute(cmd)
    else
        local normalizedPath = path:gsub("\\", "/")
        os.execute('mkdir -p "' .. normalizedPath .. '"')
    end
    
    return true
end

-- 跨平台复制文件
local function CopyFile(src, dst)
    if not src or not dst then
        Log("  CopyFile: 参数为空\n")
        return false
    end
    
    -- 使用 Lua 原生 IO 复制文件（比 os.execute 更可靠）
    local srcFile, srcErr = io.open(src, "rb")
    if not srcFile then
        Log("  CopyFile: 无法打开源文件: " .. tostring(srcErr) .. "\n")
        return false
    end
    
    local content = srcFile:read("*a")
    srcFile:close()
    
    if not content then
        Log("  CopyFile: 无法读取源文件内容\n")
        return false
    end
    
    local dstFile, dstErr = io.open(dst, "wb")
    if not dstFile then
        Log("  CopyFile: 无法创建目标文件: " .. tostring(dstErr) .. "\n")
        return false
    end
    
    local success = dstFile:write(content)
    dstFile:close()
    
    if success then
        Log("  CopyFile: 成功复制 " .. #content .. " 字节\n")
        return true
    else
        Log("  CopyFile: 写入失败\n")
        return false
    end
end

-- ============================================================
-- 结束 Windows 专用函数
-- ============================================================

-- 辅助函数：添加轨道到保留列表
function AddTrackToKeep(keepTracks, track)
    if track == nil then
        return
    end
    keepTracks[track] = true
end

-- 辅助函数：递归查找所有父级轨道
-- 返回父级轨道列表（从直接父级到最顶层）
function FindParentTracks(track, keepTracks)
    local parents = {}
    if track == nil then
        return parents
    end

    -- 获取父级轨道
    local parentTrack = reaper.GetParentTrack(track)

    if parentTrack ~= nil then
        AddTrackToKeep(keepTracks, parentTrack)
        table.insert(parents, parentTrack)
        -- 递归查找父级的父级，并收集所有父级
        local grandParents = FindParentTracks(parentTrack, keepTracks)
        for _, gp in ipairs(grandParents) do
            table.insert(parents, gp)
        end
    end

    return parents
end

-- 辅助函数：查找所有 Receive 源轨道（发送到当前轨道的轨道），返回新加入的源轨道列表
function FindReceiveSourceTracks(track, keepTracks)
    local added = {}
    if track == nil then
        return added
    end
    -- category -1 = 接收（Receive）
    local rcvCount = reaper.GetTrackNumSends(track, -1)
    if rcvCount == 0 then
        return added
    end
    for i = 0, rcvCount - 1 do
        -- P_SRCTRACK = 源轨道（发送到本轨的轨道）
        local srcTrack = reaper.GetTrackSendInfo_Value(track, -1, i, "P_SRCTRACK")
        if srcTrack ~= nil and type(srcTrack) == "userdata" then
            local trackNum = reaper.GetMediaTrackInfo_Value(srcTrack, "IP_TRACKNUMBER")
            if trackNum ~= nil then
                AddTrackToKeep(keepTracks, srcTrack)
                FindParentTracks(srcTrack, keepTracks)
                table.insert(added, srcTrack)
            end
        end
    end
    return added
end

-- 辅助函数：查找所有Send目标轨道
function FindSendTargetTracks(track, keepTracks)
    if track == nil then
        return
    end
    
    -- 检查两种类型的Send：
    -- 0 = 硬件/其他轨道输出（Send到其他轨道）
    -- -1 = 接收（Receive），这里我们主要关注Send
    
    local sendCount = reaper.GetTrackNumSends(track, 0)  -- 0 = 硬件/其他轨道输出
    reaper.ShowConsoleMsg(string.format("  检查轨道Send: 找到 %d 个Send\n", sendCount))
    
    for i = 0, sendCount - 1 do
        -- GetTrackSendInfo_Value 返回目标轨道的对象
        -- 参数：track, category (0=send, -1=receive), sendidx, parmname
        local destTrack = reaper.GetTrackSendInfo_Value(track, 0, i, "P_DESTTRACK")
        
        if destTrack ~= nil then
            -- 验证这是一个有效的track对象
            local isValid = false
            local destTrackName = "未知"
            
            -- 尝试获取轨道名称来验证
            local ret, name = reaper.GetSetMediaTrackInfo_String(destTrack, "P_NAME", "", false)
            if ret then
                isValid = true
                destTrackName = name or "未命名"
            else
                -- 如果获取名称失败，尝试通过其他方式验证
                local trackNum = reaper.GetMediaTrackInfo_Value(destTrack, "IP_TRACKNUMBER")
                if trackNum ~= nil then
                    isValid = true
                    destTrackName = "轨道 " .. trackNum
                end
            end
            
            if isValid then
                reaper.ShowConsoleMsg(string.format("    ✓ 找到Send目标轨道: %s\n", destTrackName))
                AddTrackToKeep(keepTracks, destTrack)
                FindParentTracks(destTrack, keepTracks)
            else
                reaper.ShowConsoleMsg(string.format("    ✗ Send目标无效\n"))
            end
        end
    end
end

-- 依赖追踪函数（BFS递归版本）
function GetRelatedTracks(item)
    local keepTracks = {}
    if item == nil then
        reaper.ShowConsoleMsg("警告：GetRelatedTracks收到nil item\n")
        return keepTracks
    end

    local itemTrack = reaper.GetMediaItemTrack(item)
    if itemTrack == nil then
        reaper.ShowConsoleMsg("警告：无法获取Item所在轨道\n")
        return keepTracks
    end

    local _, trackName = reaper.GetSetMediaTrackInfo_String(itemTrack, "P_NAME", "", false)
    reaper.ShowConsoleMsg(string.format("依赖追踪开始：Item所在轨道 = %s\n", trackName or "未命名"))

    -- 1. 添加Item自身所在轨道
    AddTrackToKeep(keepTracks, itemTrack)
    reaper.ShowConsoleMsg("  1. 添加自身轨道\n")

    -- 2. 递归查找父级轨道（并获取父级列表）
    reaper.ShowConsoleMsg("  2. 查找父级轨道\n")
    local parentTracks = FindParentTracks(itemTrack, keepTracks)

    -- 2.5. 如果是 folder track，查找所有子轨道
    local folderDepth = reaper.GetMediaTrackInfo_Value(itemTrack, "I_FOLDERDEPTH")
    if folderDepth == 1 then
        reaper.ShowConsoleMsg("  2.5. 检测到 Folder Track，收集子轨道\n")
        local trackIdx = reaper.GetMediaTrackInfo_Value(itemTrack, "IP_TRACKNUMBER") - 1
        local depth = 1
        for ci = trackIdx + 1, reaper.CountTracks(0) - 1 do
            local childTrack = reaper.GetTrack(0, ci)
            if not childTrack then break end
            AddTrackToKeep(keepTracks, childTrack)
            local _, childName = reaper.GetSetMediaTrackInfo_String(childTrack, "P_NAME", "", false)
            reaper.ShowConsoleMsg("    子轨道: " .. (childName or "未命名") .. "\n")
            depth = depth + reaper.GetMediaTrackInfo_Value(childTrack, "I_FOLDERDEPTH")
            if depth <= 0 then break end
        end
    end

    -- 3. 查找Send目标轨道（递归）
    reaper.ShowConsoleMsg("  3. 查找Send目标轨道（递归）\n")

    -- 创建一个待处理队列，初始包含Item轨道和所有父级轨道
    local queue = {itemTrack}
    local processed = {}

    -- 标记Item轨道为已处理
    processed[itemTrack] = true

    -- 将所有父级轨道也加入队列
    for _, parentTrack in ipairs(parentTracks) do
        if not processed[parentTrack] then
            table.insert(queue, parentTrack)
            processed[parentTrack] = true
        end
    end

    -- 处理队列中的每个轨道（只沿信号流方向：Send 目标及父级，不保留发送到本轨的 Receive 源）
    while #queue > 0 do
        local currentTrack = table.remove(queue, 1)

        -- 查找当前轨道的 Send 目标（只追踪“本轨发送到谁”，不追踪“谁发到本轨”）
        local sendCount = reaper.GetTrackNumSends(currentTrack, 0)
        if sendCount > 0 then
            local currentTrackName = reaper.GetSetMediaTrackInfo_String(currentTrack, "P_NAME", "", false) or "未命名"
            reaper.ShowConsoleMsg(string.format("  检查轨道 %s 的 %d 个Send\n", currentTrackName, sendCount))

            for i = 0, sendCount - 1 do
                -- 使用原生API获取Send目标轨道
                local destTrack = reaper.GetTrackSendInfo_Value(currentTrack, 0, i, "P_DESTTRACK")

                if destTrack ~= nil then
                    -- 验证轨道有效性
                    local trackNum = reaper.GetMediaTrackInfo_Value(destTrack, "IP_TRACKNUMBER")
                    if trackNum ~= nil then
                        local destTrackName = reaper.GetSetMediaTrackInfo_String(destTrack, "P_NAME", "", false) or "未命名"
                        reaper.ShowConsoleMsg(string.format("    ✓ 找到Send目标: %s (轨道%d)\n", destTrackName, trackNum))

                        -- 添加到保留列表
                        AddTrackToKeep(keepTracks, destTrack)

                        -- 如果这个Send目标还没被处理过，加入队列
                        if not processed[destTrack] then
                            processed[destTrack] = true
                            table.insert(queue, destTrack)

                            -- 同时查找Send目标的父级轨道
                            local newParents = FindParentTracks(destTrack, keepTracks)
                            -- 将Send目标的父级轨道也加入队列
                            for _, newParent in ipairs(newParents) do
                                if not processed[newParent] then
                                    table.insert(queue, newParent)
                                    processed[newParent] = true
                                end
                            end
                        end
                    else
                        reaper.ShowConsoleMsg("    ✗ Send目标无效\n")
                    end
                end
            end
        end
    end

    return keepTracks
end

-- 生成UUID（简单版本）
function GenerateUUID()
    local template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
    return string.gsub(template, "[xy]", function(c)
        local v = (c == "x") and math.random(0, 0xf) or math.random(8, 0xb)
        return string.format("%x", v)
    end)
end

-- 获取Item名称（从文件名或轨道名推断）
function GetItemName(item)
    local take = reaper.GetActiveTake(item)
    if take ~= nil then
        local _, sourceName = reaper.GetSetMediaItemTakeInfo_String(take, "P_NAME", "", false)
        if sourceName ~= "" then
            -- 移除文件扩展名
            return string.gsub(sourceName, "%.%w+$", "")
        end
    end
    
    local track = reaper.GetMediaItemTrack(item)
    if track ~= nil then
        local _, trackName = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
        if trackName ~= "" then
            return trackName
        end
    end
    
    return "Capsule_" .. GenerateUUID()
end

-- 获取时间选择范围（始终基于所有选中Item的范围）
function GetTimeSelection()
    local startTime, endTime = 0, 0
    local itemCount = reaper.CountSelectedMediaItems(0)

    if itemCount > 0 then
        -- 始终使用选中Item的范围
        local firstItem = reaper.GetSelectedMediaItem(0, 0)
        startTime = reaper.GetMediaItemInfo_Value(firstItem, "D_POSITION")
        endTime = startTime + reaper.GetMediaItemInfo_Value(firstItem, "D_LENGTH")

        for i = 1, itemCount - 1 do
            local item = reaper.GetSelectedMediaItem(0, i)
            local itemStart = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
            local itemEnd = itemStart + reaper.GetMediaItemInfo_Value(item, "D_LENGTH")

            if itemStart < startTime then
                startTime = itemStart
            end
            if itemEnd > endTime then
                endTime = itemEnd
            end
        end
    end

    return startTime, endTime
end

-- 设置时间选择范围（应用到当前项目）
function SetTimeSelection(startTime, endTime)
    reaper.GetSet_LoopTimeRange(true, false, startTime, endTime, false)
end

local function ClampPreviewEndTime(startTime, endTime)
    if not startTime or not endTime then
        return startTime or 0, endTime or 0, false
    end
    if endTime - startTime > MAX_PREVIEW_SECONDS then
        return startTime, startTime + MAX_PREVIEW_SECONDS, true
    end
    return startTime, endTime, false
end

-- 检测系统是否安装 FFmpeg
function CheckFFmpegAvailable()
    local cmd = 'ffmpeg -version 2>&1'
    local handle = io.popen(cmd)
    if not handle then
        return false, "无法执行 FFmpeg 命令"
    end

    local output = handle:read("*a")
    handle:close()

    -- 检查输出是否包含 "ffmpeg" 字符串
    if string.find(output, "ffmpeg") then
        -- 提取版本信息
        local version = string.match(output, "ffmpeg version ([%d%.]+)")
        return true, version or "已安装"
    else
        return false, "FFmpeg 未安装"
    end
end

-- 使用 FFmpeg 将 WAV 转换为 OGG
function ConvertWavToOgg(wavPath, oggPath)
    -- 检查源文件是否存在
    local wavFile = io.open(wavPath, "r")
    if not wavFile then
        reaper.ShowConsoleMsg("✗ WAV 文件不存在: " .. wavPath .. "\n")
        return false
    end
    wavFile:close()

    -- 构建 FFmpeg 命令
    -- -q:a 4 是 OGG Vorbis 质量设置（0-10，4 是较好的质量）
    -- -c:a libvorbis 指定使用 Vorbis 编码器
    local ffmpegCmd = string.format('ffmpeg -y -i "%s" -c:a libvorbis -q:a 4 "%s"', wavPath, oggPath)

    -- 执行转换
    local result, exitType, exitCode = os.execute(ffmpegCmd .. ' 2>&1')
    local commandOk = (result == true) or (result == 0) or (exitCode == 0)

    if commandOk then
        -- 验证输出文件
        local oggFile = io.open(oggPath, "r")
        if oggFile then
            oggFile:close()
            return true
        else
            return false
        end
    else
        return false
    end
end

-- 修剪工程：删除未标记的轨道
local function SplitOutputPath(path)
    local dir = GetDirectoryPath(path)
    local name = tostring(path or ""):match("[^/\\]+$") or ""
    local base = name:gsub("%.[^%.]+$", "")
    return dir, base, name
end

local function GetProjectStringInfo(key)
    local _, value = reaper.GetSetProjectInfo_String(0, key, "", false)
    return value or ""
end

local function SetProjectStringInfo(key, value)
    reaper.GetSetProjectInfo_String(0, key, value or "", true)
end

local function GetProjectNumericInfo(key)
    return reaper.GetSetProjectInfo(0, key, 0, false) or 0
end

local function SetProjectNumericInfo(key, value)
    reaper.GetSetProjectInfo(0, key, value or 0, true)
end

local function RestoreCurrentProjectRenderState(state)
    if not state then return end
    SetProjectStringInfo("RENDER_FILE", state.render_file)
    SetProjectStringInfo("RENDER_PATTERN", state.render_pattern)
    SetProjectStringInfo("RENDER_FORMAT", state.render_format)
    SetProjectNumericInfo("RENDER_RANGE", state.render_range)
    SetProjectNumericInfo("RENDER_STEMS", state.render_stems)
    SetProjectNumericInfo("RENDER_1X", state.render_1x)
    reaper.GetSet_LoopTimeRange(true, false, state.time_start or 0, state.time_end or 0, false)
end

function RenderPreviewAudioFromCurrentProject(outputPath, startTime, endTime)
    reaper.ShowConsoleMsg("\n[RenderPreviewAudioFromCurrentProject] start\n")
    reaper.ShowConsoleMsg("  output: " .. tostring(outputPath) .. "\n")

    local previewStartTime, previewEndTime, previewClamped = ClampPreviewEndTime(startTime, endTime)
    if previewClamped then
        reaper.ShowConsoleMsg("  preview clamped to " .. MAX_PREVIEW_SECONDS .. " seconds\n")
    end

    local outputDir, outputBase = SplitOutputPath(outputPath)
    if outputDir == "" or outputBase == "" then
        reaper.ShowConsoleMsg("  invalid preview output path\n")
        return false
    end
    MakeDir(outputDir)

    local isOggOutput = string.match(outputPath, "%.ogg$")
    local renderPath = outputPath
    local tempWavPath = nil
    if isOggOutput then
        local ffmpegAvailable = CheckFFmpegAvailable()
        if ffmpegAvailable then
            tempWavPath = string.gsub(outputPath, "%.ogg$", "_temp.wav")
            renderPath = tempWavPath
        else
            renderPath = string.gsub(outputPath, "%.ogg$", ".wav")
            reaper.ShowConsoleMsg("  ffmpeg unavailable, keeping WAV preview\n")
        end
    end

    local renderDir, renderBase = SplitOutputPath(renderPath)
    os.remove(renderPath)
    if outputPath ~= renderPath then
        os.remove(outputPath)
    end
    local timeStart, timeEnd = reaper.GetSet_LoopTimeRange(false, false, 0, 0, false)
    local state = {
        render_file = GetProjectStringInfo("RENDER_FILE"),
        render_pattern = GetProjectStringInfo("RENDER_PATTERN"),
        render_format = GetProjectStringInfo("RENDER_FORMAT"),
        render_range = GetProjectNumericInfo("RENDER_RANGE"),
        render_stems = GetProjectNumericInfo("RENDER_STEMS"),
        render_1x = GetProjectNumericInfo("RENDER_1X"),
        time_start = timeStart,
        time_end = timeEnd,
    }

    local renderOk = false
    local ok, err = pcall(function()
        reaper.GetSet_LoopTimeRange(true, false, previewStartTime, previewEndTime, false)
        SetProjectStringInfo("RENDER_FILE", renderDir)
        SetProjectStringInfo("RENDER_PATTERN", renderBase)
        -- Render WAV from the current project, then convert to OGG if needed.
        -- This avoids depending on the user's REAPER encoder configuration.
        SetProjectStringInfo("RENDER_FORMAT", "evaw")
        SetProjectNumericInfo("RENDER_RANGE", 1)
        SetProjectNumericInfo("RENDER_STEMS", 0)
        SetProjectNumericInfo("RENDER_1X", 0)
        reaper.UpdateArrange()
        if reaper.RenderProject_Table then
            local success, ret = reaper.RenderProject_Table(
                nil,
                2,
                previewStartTime,
                previewEndTime,
                1.0,
                renderPath,
                0,
                0,
                false
            )
            renderOk = (success == true and ret ~= false)
        elseif reaper.RenderProject then
            local ret = reaper.RenderProject(nil, false, false, renderPath)
            renderOk = tonumber(ret or 0) > 0
        else
            renderOk = false
        end
    end)

    RestoreCurrentProjectRenderState(state)

    if not ok then
        reaper.ShowConsoleMsg("  current project preview render failed: " .. tostring(err) .. "\n")
        return false
    end
    if not renderOk then
        reaper.ShowConsoleMsg("  current project preview render API was unavailable or returned failure\n")
        return false
    end

    local f = io.open(renderPath, "r")
    if not f then
        reaper.ShowConsoleMsg("  preview output not found: " .. tostring(renderPath) .. "\n")
        return false
    end
    f:close()

    if tempWavPath and isOggOutput then
        if ConvertWavToOgg(tempWavPath, outputPath) then
            os.execute('del /Q "' .. tempWavPath:gsub("/", "\\") .. '" >nul 2>&1')
            return true
        end
        reaper.ShowConsoleMsg("  WAV to OGG conversion failed, keeping WAV preview\n")
        local finalWavPath = string.gsub(outputPath, "%.ogg$", ".wav")
        os.execute('move /Y "' .. tempWavPath:gsub("/", "\\") .. '" "' .. finalWavPath:gsub("/", "\\") .. '" >nul 2>&1')
        return true
    end

    return true
end

function PruneTracks(keepTracks)
    local trackCount = reaper.CountTracks(0)
    
    reaper.ShowConsoleMsg(string.format("修剪轨道：当前有 %d 个轨道，需要保留 %d 个\n", trackCount,
        (function() local count = 0; for _ in pairs(keepTracks) do count = count + 1 end; return count end)()))
    
    -- 打印需要保留的轨道
    reaper.ShowConsoleMsg("需要保留的轨道列表:\n")
    for track, _ in pairs(keepTracks) do
        if track ~= nil then
            local _, trackName = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
            local trackNum = reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER")
            reaper.ShowConsoleMsg(string.format("  ✓ 轨道 %d: %s\n", trackNum, trackName or "未命名"))
        end
    end
    
    -- 倒序遍历所有轨道（不包括Master轨道）
    for i = trackCount - 1, 0, -1 do
        local track = reaper.GetTrack(0, i)
        
        if track ~= nil then
            -- 检查是否是Master轨道（Master轨道不应该被删除）
            local isMaster = reaper.GetMediaTrackInfo_Value(track, "I_ISMASTER")
            if isMaster == 0 then
                -- 如果轨道不在保留列表中，删除它
                if keepTracks[track] ~= true then
                    local _, trackName = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
                    local trackNum = reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER")
                    reaper.ShowConsoleMsg(string.format("  ✗ 删除轨道 %d: %s\n", trackNum, trackName or "未命名"))
                    reaper.DeleteTrack(track)
                else
                    local _, trackName = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
                    local trackNum = reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER")
                    reaper.ShowConsoleMsg(string.format("  ✓ 保留轨道 %d: %s\n", trackNum, trackName or "未命名"))
                end
            end
        end
    end
    
    local remainingCount = reaper.CountTracks(0)
    reaper.ShowConsoleMsg(string.format("修剪完成：剩余 %d 个轨道（包括Master）\n", remainingCount))
end

-- 修复文件夹层次结构，确保只在保留的轨道之间保持正确的父子关系
function FixFolderHierarchy(keepTracks)
    reaper.ShowConsoleMsg("修复轨道文件夹层次结构...\n")
    local trackCount = reaper.CountTracks(0)

    -- 第一遍：清除所有指向未保留轨道的父子关系
    for i = 0, trackCount - 1 do
        local track = reaper.GetTrack(0, i)
        if track ~= nil then
            local isMaster = reaper.GetMediaTrackInfo_Value(track, "I_ISMASTER")
            if isMaster == 0 then
                -- 检查这个轨道的父轨道
                local parentTrack = reaper.GetParentTrack(track)

                if parentTrack ~= nil then
                    -- 如果父轨道不在保留列表中，清除父子关系
                    if not keepTracks[parentTrack] then
                        local _, trackName = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
                        local trackNum = reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER")
                        local _, parentName = reaper.GetSetMediaTrackInfo_String(parentTrack, "P_NAME", "", false)
                        local parentNum = reaper.GetMediaTrackInfo_Value(parentTrack, "IP_TRACKNUMBER")

                        reaper.ShowConsoleMsg(string.format("  清除轨道 %d (%s) 对已删除父轨道 %d (%s) 的引用\n",
                            trackNum, trackName or "未命名", parentNum, parentName or "未命名"))

                        -- 设置为 0 = 不是子轨道
                        reaper.SetMediaTrackInfo_Value(track, "I_FOLDERDEPTH", 0)
                    end
                end
            end
        end
    end

    -- 第二遍：清除指向未保留轨道的文件夹开始标记
    for i = 0, trackCount - 1 do
        local track = reaper.GetTrack(0, i)
        if track ~= nil then
            local isMaster = reaper.GetMediaTrackInfo_Value(track, "I_ISMASTER")
            if isMaster == 0 then
                local folderDepth = reaper.GetMediaTrackInfo_Value(track, "I_FOLDERDEPTH")

                -- 如果是文件夹开始 (depth = 1)
                if folderDepth == 1 then
                    -- 检查这个文件夹是否还有子轨道被保留
                    local hasChildren = false
                    for j = i + 1, trackCount - 1 do
                        local childTrack = reaper.GetTrack(0, j)
                        if childTrack ~= nil then
                            local childParent = reaper.GetParentTrack(childTrack)
                            if childParent == track and keepTracks[childTrack] then
                                hasChildren = true
                                break
                            end
                        end
                    end

                    -- 如果文件夹没有子轨道了，清除文件夹标记
                    if not hasChildren then
                        local _, trackName = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
                        local trackNum = reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER")
                        reaper.ShowConsoleMsg(string.format("  清除轨道 %d (%s) 的空文件夹标记\n",
                            trackNum, trackName or "未命名"))
                        reaper.SetMediaTrackInfo_Value(track, "I_FOLDERDEPTH", 0)
                    else
                        local _, trackName = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
                        local trackNum = reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER")
                        reaper.ShowConsoleMsg(string.format("  保留轨道 %d (%s) 的文件夹结构\n",
                            trackNum, trackName or "未命名"))
                    end
                end
            end
        end
    end

    reaper.ShowConsoleMsg("✓ 文件夹层次结构已修复\n")
end

-- 获取当前工程在 Project Settings 里设置的媒体文件夹名（非 Audio 时也能正确解析路径）
function GetProjectMediaFolderName()
    local ret, recPath = reaper.GetSetProjectInfo_String(0, "RECORD_PATH", "", false)
    if not recPath or recPath == "" then return "Audio" end
    -- 取路径最后一段（支持 / 和 \）
    local last = recPath:match("([^/\\]+)[/\\]?$") or recPath:match("([^/\\]+)$")
    return (last and last ~= "" and last) or "Audio"
end

-- 从RPP文件中提取所有媒体文件路径（sourceMediaFolder 可选，为当前工程的媒体文件夹名，默认 Audio）
function ExtractMediaFilesFromRPP(rppPath, sourceProjectDir, sourceMediaFolder)
    if sourceMediaFolder == nil then sourceMediaFolder = "Audio" end
    local mediaFiles = {}
    local file = io.open(rppPath, "r")
    if not file then
        return mediaFiles
    end
    
    local rppDir = GetDirectoryPath(rppPath)
    local content = file:read("*all")
    file:close()
    
    -- 在RPP文件中查找<SOURCE标签，这包含媒体文件路径
    -- 格式通常是: <SOURCE WAVE\n    FILE "path/to/file.wav"\n>
    
    -- 匹配多行的SOURCE块（包括FILE行）
    -- 使用更灵活的模式来匹配整个SOURCE块，包括其内容
    local sourceStart = 1
    
    reaper.ShowConsoleMsg("开始解析RPP文件: " .. rppPath .. "\n")
    
    while true do
        -- 查找SOURCE开始位置
        local sourceStartPos = string.find(content, "<SOURCE", sourceStart)
        if not sourceStartPos then
            break
        end
        
        -- 查找SOURCE块的范围（从<SOURCE到>）
        -- SOURCE块可能是单行或多行，我们需要找到对应的闭合标签
        local sourceEndPos = string.find(content, ">", sourceStartPos)
        if not sourceEndPos then
            break
        end
        
        -- 在SOURCE块附近查找FILE行（可能在下一行）
        -- 查找范围：从SOURCE结束到下一个<标签或空白行
        local searchEnd = string.find(content, "<", sourceEndPos + 1) or (#content + 1)
        local sourceBlock = string.sub(content, sourceStartPos, math.min(sourceEndPos + 100, searchEnd - 1))
        
        -- 在SOURCE块中查找FILE行
        local fileMatch = nil
        
        -- 尝试匹配 FILE "路径" 模式
        fileMatch = string.match(sourceBlock, 'FILE%s+"([^"]+)"')
        if not fileMatch then
            -- 尝试单引号
            fileMatch = string.match(sourceBlock, "FILE%s+'([^']+)'")
        end
        if not fileMatch then
            -- 尝试更宽松的匹配
            fileMatch = string.match(sourceBlock, 'FILE%s+(%S+)')
        end
        
        if fileMatch then
            reaper.ShowConsoleMsg("找到FILE路径: " .. fileMatch .. "\n")
        end
        
        if fileMatch then
            -- 移除可能的前导/尾随空白
            fileMatch = string.gsub(fileMatch, "^%s+", "")
            fileMatch = string.gsub(fileMatch, "%s+$", "")
            
            local mediaPath = fileMatch
            local baseName = string.match(mediaPath, "([^/\\]+)$") or mediaPath
            
            -- 如果是相对路径（任意媒体文件夹名，如 Audio/Media/Wav），转换为绝对路径
            if not string.match(mediaPath, "^/") and not string.match(mediaPath, "^[A-Z]:") then
                -- 提取相对路径中的文件名（去掉首段文件夹前缀，如 Audio/、Media/、Wav/）
                local relativeFileName = string.match(mediaPath, "[^/\\]+[/\\](.+)") or mediaPath
                
                -- 尝试多种可能的路径（优先使用当前工程设置的媒体文件夹名）
                local testPaths = {}
                
                -- 如果提供了源项目目录，优先使用（使用跨平台 JoinPath）
                if sourceProjectDir and sourceProjectDir ~= "" then
                    table.insert(testPaths, JoinPath(sourceProjectDir, sourceMediaFolder, relativeFileName))
                    table.insert(testPaths, JoinPath(sourceProjectDir, "audio", relativeFileName))
                    table.insert(testPaths, JoinPath(sourceProjectDir, "Audio", relativeFileName))
                    table.insert(testPaths, JoinPath(sourceProjectDir, relativeFileName))
                end
                
                -- 也尝试RPP文件所在目录
                if rppDir ~= "" then
                    table.insert(testPaths, JoinPath(rppDir, sourceMediaFolder, relativeFileName))
                    table.insert(testPaths, JoinPath(rppDir, "audio", relativeFileName))
                    table.insert(testPaths, JoinPath(rppDir, "Audio", relativeFileName))
                    table.insert(testPaths, JoinPath(rppDir, relativeFileName))
                end
                
                -- 尝试原始工程目录
                local _, origProj = reaper.EnumProjects(-1, "")
                if origProj ~= "" then
                    local origDir = GetDirectoryPath(origProj)
                    if origDir ~= "" then
                        table.insert(testPaths, JoinPath(origDir, sourceMediaFolder, relativeFileName))
                        table.insert(testPaths, JoinPath(origDir, "audio", relativeFileName))
                        table.insert(testPaths, JoinPath(origDir, "Audio", relativeFileName))
                        table.insert(testPaths, JoinPath(origDir, relativeFileName))
                    end
                end
                
                -- 测试所有可能的路径
                local found = false
                for _, testPath in ipairs(testPaths) do
                    local f = io.open(testPath, "r")
                    if f then
                        f:close()
                        mediaPath = testPath
                        found = true
                        break
                    end
                end
                
                if not found then
                    reaper.ShowConsoleMsg("警告：无法找到媒体文件: " .. fileMatch .. "\n")
                    reaper.ShowConsoleMsg("  尝试过的路径: " .. table.concat(testPaths, ", ") .. "\n")
                end
            end
            
            -- 验证文件是否存在
            local f = io.open(mediaPath, "r")
            if f then
                f:close()
                if not mediaFiles[mediaPath] then
                    mediaFiles[mediaPath] = baseName
                    reaper.ShowConsoleMsg("从RPP提取: " .. baseName .. " -> " .. mediaPath .. "\n")
                end
            end
        end
        
        -- 移动到下一个可能的SOURCE位置
        sourceStart = sourceEndPos + 1
    end
    
    return mediaFiles
end

-- ============================================================
-- 新版导出核心：不切换工程，只复制文件和生成新 RPP
-- ============================================================

-- 收集选中 items 的媒体文件路径（使用 REAPER API）
function CollectSelectedItemsMedia()
    local mediaFiles = {}  -- {absolutePath = baseName}
    local itemsInfo = {}   -- 记录选中 items 的信息
    local _, currentProjPath = reaper.EnumProjects(-1, "")
    local currentProjDir = GetDirectoryPath(currentProjPath)
    
    reaper.ShowConsoleMsg("\n=== 收集选中 Items 的媒体文件 ===\n")
    reaper.ShowConsoleMsg("当前工程: " .. (currentProjPath or "未知") .. "\n")
    
    local numItems = reaper.CountSelectedMediaItems(0)
    reaper.ShowConsoleMsg("选中 Items 数量: " .. numItems .. "\n")
    
    for i = 0, numItems - 1 do
        local item = reaper.GetSelectedMediaItem(0, i)
        reaper.ShowConsoleMsg("Item " .. (i+1) .. ":\n")
        
        if not item then
            reaper.ShowConsoleMsg("  ⚠ item 为 nil\n")
        else
            local take = reaper.GetActiveTake(item)
            if not take then
                reaper.ShowConsoleMsg("  ⚠ take 为 nil（空 Item / Folder Item），保留在胶囊中\n")
                local track = reaper.GetMediaItemTrack(item)
                table.insert(itemsInfo, {
                    position = reaper.GetMediaItemInfo_Value(item, "D_POSITION"),
                    length = reaper.GetMediaItemInfo_Value(item, "D_LENGTH"),
                    volume = reaper.GetMediaItemInfo_Value(item, "D_VOL"),
                    trackNum = track and reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER") or 0,
                    mediaFile = nil
                })
                -- 如果是 folder track 上的空 item，收集子轨道上的媒体文件
                if track then
                    local folderDepth = reaper.GetMediaTrackInfo_Value(track, "I_FOLDERDEPTH")
                    if folderDepth == 1 then
                        local folderStart = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
                        local folderEnd = folderStart + reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
                        reaper.ShowConsoleMsg(string.format("  Folder Item: 收集子轨道媒体 (%.2f - %.2f)\n", folderStart, folderEnd))
                        local trackIdx = reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER") - 1
                        local depth = 1
                        for ci = trackIdx + 1, reaper.CountTracks(0) - 1 do
                            local childTrack = reaper.GetTrack(0, ci)
                            if not childTrack then break end
                            local childItemCount = reaper.CountTrackMediaItems(childTrack)
                            for j = 0, childItemCount - 1 do
                                local childItem = reaper.GetTrackMediaItem(childTrack, j)
                                if childItem then
                                    local cStart = reaper.GetMediaItemInfo_Value(childItem, "D_POSITION")
                                    local cEnd = cStart + reaper.GetMediaItemInfo_Value(childItem, "D_LENGTH")
                                    if cStart < folderEnd and cEnd > folderStart then
                                        local childTake = reaper.GetActiveTake(childItem)
                                        if childTake then
                                            local childSource = reaper.GetMediaItemTake_Source(childTake)
                                            if childSource then
                                                local childSourceType = reaper.GetMediaSourceType(childSource, "")
                                                if childSourceType == "SECTION" or childSourceType == "REVERSE" then
                                                    childSource = reaper.GetMediaSourceParent(childSource)
                                                end
                                                if childSource and childSourceType ~= "MIDI" then
                                                    local retval, fileName = reaper.GetMediaSourceFileName(childSource, "")
                                                    if not fileName or fileName == "" or fileName == "?" then
                                                        if type(retval) == "string" and retval ~= "" and retval ~= "?" then fileName = retval end
                                                    end
                                                    if fileName and fileName ~= "" and fileName ~= "?" then
                                                        local isAbsolute = string.match(fileName, "^/") or string.match(fileName, "^[A-Za-z]:") or string.match(fileName, "^\\\\")
                                                        local fullPath = nil
                                                        if isAbsolute then
                                                            fullPath = fileName
                                                        else
                                                            local sourceMediaFolder = GetProjectMediaFolderName()
                                                            local testPaths = {
                                                                JoinPath(currentProjDir, sourceMediaFolder, fileName),
                                                                JoinPath(currentProjDir, fileName),
                                                                JoinPath(currentProjDir, "audio", fileName),
                                                                JoinPath(currentProjDir, "Audio", fileName),
                                                            }
                                                            for _, testPath in ipairs(testPaths) do
                                                                if testPath and testPath ~= "" then
                                                                    local f = io.open(testPath, "r")
                                                                    if f then f:close(); fullPath = testPath; break end
                                                                end
                                                            end
                                                        end
                                                        if fullPath then
                                                            local f = io.open(fullPath, "r")
                                                            if f then
                                                                f:close()
                                                                local baseName = string.match(fullPath, "([^/\\]+)$") or fullPath
                                                                if not mediaFiles[fullPath] then
                                                                    mediaFiles[fullPath] = baseName
                                                                    reaper.ShowConsoleMsg("    子 Item ✓ " .. baseName .. "\n")
                                                                end
                                                            end
                                                        end
                                                    end
                                                end
                                            end
                                        end
                                    end
                                end
                            end
                            depth = depth + reaper.GetMediaTrackInfo_Value(childTrack, "I_FOLDERDEPTH")
                            if depth <= 0 then break end
                        end
                    end
                end
            else
                local source = reaper.GetMediaItemTake_Source(take)
                if not source then
                    reaper.ShowConsoleMsg("  ⚠ source 为 nil\n")
                else
                    local sourceType = reaper.GetMediaSourceType(source, "")
                    if sourceType == "MIDI" then
                        reaper.ShowConsoleMsg("  检测到 MIDI Item，跳过文件复制步骤\n")
                        local track = reaper.GetMediaItemTrack(item)
                        table.insert(itemsInfo, {
                            position = reaper.GetMediaItemInfo_Value(item, "D_POSITION"),
                            length = reaper.GetMediaItemInfo_Value(item, "D_LENGTH"),
                            volume = reaper.GetMediaItemInfo_Value(item, "D_VOL"),
                            trackNum = track and reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER") or 0,
                            mediaFile = nil
                        })
                    else
                        if sourceType == "SECTION" or sourceType == "REVERSE" then
                            source = reaper.GetMediaSourceParent(source)
                        end
                        if source then
                            local retval, fileName = reaper.GetMediaSourceFileName(source, "")
                            if not fileName or fileName == "" or fileName == "?" then
                                if type(retval) == "string" and retval ~= "" and retval ~= "?" then
                                    fileName = retval
                                end
                            end
                            if fileName and fileName ~= "" and fileName ~= "?" then
                                local isAbsolute = string.match(fileName, "^/") or string.match(fileName, "^[A-Za-z]:") or string.match(fileName, "^\\\\")
                                local fullPath = nil
                                if isAbsolute then
                                    fullPath = fileName
                                else
                                    local sourceMediaFolder = GetProjectMediaFolderName()
                                    local testPaths = {
                                        JoinPath(currentProjDir, sourceMediaFolder, fileName),
                                        JoinPath(currentProjDir, fileName),
                                        JoinPath(currentProjDir, "audio", fileName),
                                        JoinPath(currentProjDir, "Audio", fileName),
                                    }
                                    for _, testPath in ipairs(testPaths) do
                                        local f = io.open(testPath, "r")
                                        if f then
                                            f:close()
                                            fullPath = testPath
                                            break
                                        end
                                    end
                                end
                                if fullPath then
                                    local f = io.open(fullPath, "r")
                                    if f then
                                        f:close()
                                        local baseName = string.match(fullPath, "([^/\\]+)$") or fullPath
                                        if not mediaFiles[fullPath] then
                                            mediaFiles[fullPath] = baseName
                                            reaper.ShowConsoleMsg("  ✓ " .. baseName .. "\n")
                                        end
                                    end
                                end
                                local track = reaper.GetMediaItemTrack(item)
                                table.insert(itemsInfo, {
                                    position = reaper.GetMediaItemInfo_Value(item, "D_POSITION"),
                                    length = reaper.GetMediaItemInfo_Value(item, "D_LENGTH"),
                                    volume = reaper.GetMediaItemInfo_Value(item, "D_VOL"),
                                    trackNum = track and reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER") or 0,
                                    mediaFile = fullPath
                                })
                            end
                        end
                    end
                end
            end
        end
    end  -- for
    
    local count = 0
    for _ in pairs(mediaFiles) do count = count + 1 end
    reaper.ShowConsoleMsg("共找到 " .. count .. " 个媒体文件\n")
    
    return mediaFiles, itemsInfo
end

-- 复制媒体文件到目标 Audio 目录
function CopyMediaFiles(mediaFiles, audioDir)
    reaper.ShowConsoleMsg("\n=== 复制媒体文件 ===\n")
    reaper.ShowConsoleMsg("目标目录: " .. audioDir .. "\n")
    
    MakeDir(audioDir)
    
    local copiedCount = 0
    local failedFiles = {}
    local pathMapping = {}  -- {原路径 = 新相对路径}
    
    for sourcePath, baseName in pairs(mediaFiles) do
        local targetPath = JoinPath(audioDir, baseName)
        
        reaper.ShowConsoleMsg("复制: " .. baseName .. "\n")
        
        -- 执行复制
        CopyFile(sourcePath, targetPath)
        
        -- 验证
        local f = io.open(targetPath, "r")
        if f then
            f:close()
            copiedCount = copiedCount + 1
            pathMapping[sourcePath] = "Audio/" .. baseName
            reaper.ShowConsoleMsg("  ✓ 成功\n")
        else
            table.insert(failedFiles, sourcePath)
            reaper.ShowConsoleMsg("  ✗ 失败，保留原路径\n")
        end
    end
    
    local total = 0
    for _ in pairs(mediaFiles) do total = total + 1 end
    reaper.ShowConsoleMsg("复制完成: " .. copiedCount .. "/" .. total .. "\n")
    
    return pathMapping, failedFiles
end

-- 判断本次导出是否包含 MIDI Item（用于选择渲染模式）
local function HasMidiItems(itemsInfo)
    if not itemsInfo then return false end
    for _, info in ipairs(itemsInfo) do
        if info and info.mediaFile == nil then
            return true
        end
    end
    return false
end

-- 生成新的 RPP 文件（不切换工程）
function GenerateCapsuleRPP(outputDir, capsuleName, pathMapping, renderPreview, startTime, endTime, hasMidiItems)
    reaper.ShowConsoleMsg("\n=== 生成胶囊 RPP ===\n")
    
    -- 获取当前工程路径
    local _, currentProjPath = reaper.EnumProjects(-1, "")
    local isTemporaryProject = (not currentProjPath or currentProjPath == "")
    local tempRppPath = nil
    
    if isTemporaryProject then
        -- 临时工程：先保存到临时文件
        reaper.ShowConsoleMsg("⚠ 检测到临时工程，先保存到临时文件\n")
        tempRppPath = JoinPath(outputDir, "_temp_source.rpp")
        
        -- 设置 RECORD_PATH 为 Audio 文件夹
        reaper.GetSetProjectInfo_String(0, "RECORD_PATH", "Audio", true)
        
        -- 使用 Main_SaveProjectEx 保存到临时文件
        reaper.Main_SaveProjectEx(0, tempRppPath, 0)
        currentProjPath = tempRppPath
        reaper.ShowConsoleMsg("临时工程已保存到: " .. tempRppPath .. "\n")
    else
        -- 已保存的工程：正常保存当前状态
        reaper.ShowConsoleMsg("保存当前工程状态: " .. currentProjPath .. "\n")
        reaper.Main_SaveProject(0, false)
    end
    
    -- 读取 RPP 内容
    reaper.ShowConsoleMsg("读取 RPP: " .. currentProjPath .. "\n")
    local sourceFile = io.open(currentProjPath, "r")
    if not sourceFile then
        reaper.ShowConsoleMsg("✗ 无法读取 RPP\n")
        return nil
    end
    local content = sourceFile:read("*all")
    sourceFile:close()
    
    -- ============================================================
    -- 步骤 1：收集需要保留的轨道（依赖追踪）+ 选中 Item 的 GUID
    -- ============================================================
    reaper.ShowConsoleMsg("收集需要保留的轨道...\n")
    
    local keepTrackNumbers = {}
    local selectedItemGUIDs = {}  -- 用于 RPP 中按 IGUID 精确匹配
    local numItems = reaper.CountSelectedMediaItems(0)
    for i = 0, numItems - 1 do
        local item = reaper.GetSelectedMediaItem(0, i)
        if item then
            -- 收集 item 的 GUID
            local _, itemGUID = reaper.GetSetMediaItemInfo_String(item, "GUID", "", false)
            if itemGUID and itemGUID ~= "" then
                selectedItemGUIDs[itemGUID:lower()] = true
                reaper.ShowConsoleMsg("  选中 Item GUID: " .. itemGUID .. "\n")
            end
            local relatedTracks = GetRelatedTracks(item)
            for track, _ in pairs(relatedTracks) do
                local trackNum = reaper.GetMediaTrackInfo_Value(track, "IP_TRACKNUMBER")
                keepTrackNumbers[trackNum] = true
                local _, trackName = reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "", false)
                reaper.ShowConsoleMsg("  保留轨道 " .. trackNum .. ": " .. (trackName or "未命名") .. "\n")
            end

            -- Folder item：收集子轨道上时间范围内所有 item 的 GUID
            local itemTrack = reaper.GetMediaItemTrack(item)
            if itemTrack then
                local folderDepth = reaper.GetMediaTrackInfo_Value(itemTrack, "I_FOLDERDEPTH")
                local take = reaper.GetActiveTake(item)
                if folderDepth == 1 and not take then
                    local folderStart = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
                    local folderEnd = folderStart + reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
                    reaper.ShowConsoleMsg(string.format("  Folder Item 时间范围: %.2f - %.2f，收集子 Item...\n", folderStart, folderEnd))
                    local trackIdx = reaper.GetMediaTrackInfo_Value(itemTrack, "IP_TRACKNUMBER") - 1
                    local depth = 1
                    for ci = trackIdx + 1, reaper.CountTracks(0) - 1 do
                        local childTrack = reaper.GetTrack(0, ci)
                        if not childTrack then break end
                        local childItemCount = reaper.CountTrackMediaItems(childTrack)
                        for j = 0, childItemCount - 1 do
                            local childItem = reaper.GetTrackMediaItem(childTrack, j)
                            if childItem then
                                local cStart = reaper.GetMediaItemInfo_Value(childItem, "D_POSITION")
                                local cEnd = cStart + reaper.GetMediaItemInfo_Value(childItem, "D_LENGTH")
                                if cStart < folderEnd and cEnd > folderStart then
                                    local _, cGUID = reaper.GetSetMediaItemInfo_String(childItem, "GUID", "", false)
                                    if cGUID and cGUID ~= "" then
                                        selectedItemGUIDs[cGUID:lower()] = true
                                        reaper.ShowConsoleMsg("    子 Item GUID: " .. cGUID .. "\n")
                                    end
                                end
                            end
                        end
                        depth = depth + reaper.GetMediaTrackInfo_Value(childTrack, "I_FOLDERDEPTH")
                        if depth <= 0 then break end
                    end
                end
            end
        end
    end
    
    -- ============================================================
    -- 步骤 2：删除不相关的 TRACK 块，并建立旧轨道号 -> 新轨道号 映射
    -- ============================================================
    reaper.ShowConsoleMsg("清理不相关的轨道...\n")
    
    local newContent = ""
    local inTrack = false
    local trackContent = ""
    local trackDepth = 0
    local currentTrackNum = 0
    local removedTrackCount = 0
    local keptCount = 0
    local oldIndexToNewIndex = {}  -- 修剪后 SEND/RECEIVE 中的轨道号需重映射
    
    for line in content:gmatch("([^\r\n]*)\r?\n?") do
        if line:match("^%s*<TRACK") then
            inTrack = true
            trackDepth = 1
            currentTrackNum = currentTrackNum + 1
            trackContent = line .. "\n"
        elseif inTrack then
            trackContent = trackContent .. line .. "\n"
            if line:match("^%s*</TRACK>") then trackDepth = 0 end  -- 兼容 </TRACK> 结束格式
            if line:match("^%s*<") and not line:match("^%s*<[^>]*>%s*$") then
                trackDepth = trackDepth + 1
            end
            if line:match("^%s*>%s*$") then
                trackDepth = trackDepth - 1
            end
            if trackDepth == 0 then
                -- 轨道块结束（可能是 > 或 </TRACK>），提交当前轨道
                if keepTrackNumbers[currentTrackNum] then
                    keptCount = keptCount + 1
                    local fileIdx0 = currentTrackNum - 1
                    oldIndexToNewIndex[fileIdx0] = keptCount - 1
                    newContent = newContent .. trackContent
                else
                    removedTrackCount = removedTrackCount + 1
                end
                inTrack = false
                trackContent = ""
            end
        else
            newContent = newContent .. line .. "\n"
        end
    end
    content = newContent
    reaper.ShowConsoleMsg("  删除了 " .. removedTrackCount .. " 个不相关的轨道\n")

    -- 重映射轨道路由号：RPP 使用 AUXRECV（receive）、SEND/AUXRENDER（send），均为 0-based（State Chunk 文档）
    if keptCount > 0 and next(oldIndexToNewIndex) then
        reaper.ShowConsoleMsg("重映射轨道路由号 (AUXRECV/SEND/AUXRENDER 0-based)...\n")
        -- 使用函数替换，精确匹配完整数字避免部分匹配
        local function remapTrackIndex(prefix, numStr)
            local num = tonumber(numStr)
            if num ~= nil and oldIndexToNewIndex[num] ~= nil then
                return prefix .. oldIndexToNewIndex[num]
            end
            return prefix .. numStr
        end
        content = content:gsub("(AUXRECV%s+)(%d+)", remapTrackIndex)
        content = content:gsub("(AUXSEND%s+)(%d+)", remapTrackIndex)
        content = content:gsub("(AUXRENDER%s+)(%d+)", remapTrackIndex)
        -- 删除引用不存在轨道的路由行（索引 >= 保留轨道数说明目标已被移除）
        local finalContent = ""
        for line in content:gmatch("([^\n]*)\n?") do
            local keepLine = true
            local auxrecvIdx = line:match("^%s*AUXRECV%s+(%d+)")
            if auxrecvIdx then
                local idx = tonumber(auxrecvIdx)
                if idx >= keptCount then
                    keepLine = false
                    reaper.ShowConsoleMsg("  删除无效路由: AUXRECV " .. idx .. " (仅保留 " .. keptCount .. " 轨)\n")
                end
            end
            if keepLine then
                finalContent = finalContent .. line .. "\n"
            end
        end
        content = finalContent
        reaper.ShowConsoleMsg("  轨道路由号重映射完成\n")
    end
    
    -- ============================================================
    -- 步骤 3：删除未选中的 ITEM 块
    -- 策略：保留通过 GUID 匹配的 item + 时间范围与选区重叠的 item（覆盖 folder 子 item）
    -- ============================================================
    reaper.ShowConsoleMsg("清理未选中的 Items...\n")
    reaper.ShowConsoleMsg(string.format("  时间选区: %.4f - %.4f\n", startTime, endTime))
    
    -- 获取选中媒体的文件名列表
    local selectedMediaNames = {}
    for origPath, _ in pairs(pathMapping) do
        local baseName = string.match(origPath, "([^/\\]+)$")
        if baseName then
            selectedMediaNames[baseName:lower()] = true
        end
    end
    
    -- 删除不包含选中媒体的 ITEM 块
    local removedCount = 0
    local newContent = ""
    local inItem = false
    local itemContent = ""
    local itemDepth = 0
    
    for line in content:gmatch("([^\r\n]*)\r?\n?") do
        if line:match("^%s*<ITEM") then
            inItem = true
            itemDepth = 1
            itemContent = line .. "\n"
        elseif inItem then
            itemContent = itemContent .. line .. "\n"
            if line:match("^%s*</ITEM>") then itemDepth = 0 end
            if line:match("^%s*<") then itemDepth = itemDepth + 1 end
            if line:match("^%s*>") then itemDepth = itemDepth - 1 end
            if itemDepth == 0 then
                local keepItem = false
                -- 方法 1：IGUID 精确匹配
                local iguid = itemContent:match("IGUID%s+({[^}]+})")
                if iguid and selectedItemGUIDs[iguid:lower()] then
                    keepItem = true
                end
                -- 方法 2：时间范围重叠（覆盖 folder 子 item 和所有保留轨道上的 item）
                if not keepItem and startTime and endTime then
                    local itemPos = tonumber(itemContent:match("POSITION%s+([%d%.%-]+)"))
                    local itemLen = tonumber(itemContent:match("LENGTH%s+([%d%.%-]+)"))
                    if itemPos and itemLen then
                        local itemEnd = itemPos + itemLen
                        if itemPos < endTime and itemEnd > startTime then
                            keepItem = true
                        end
                    end
                end
                -- 方法 3：MIDI 或媒体文件名匹配（兜底）
                if not keepItem then
                    if itemContent:lower():find("source midi", 1, true) then
                        keepItem = true
                    else
                        for mediaName, _ in pairs(selectedMediaNames) do
                            if itemContent:lower():find(mediaName, 1, true) then keepItem = true; break end
                        end
                    end
                end
                if keepItem then
                    newContent = newContent .. itemContent
                else
                    removedCount = removedCount + 1
                end
                inItem = false
                itemContent = ""
            end
        else
            newContent = newContent .. line .. "\n"
        end
    end
    content = newContent
    reaper.ShowConsoleMsg("  删除了 " .. removedCount .. " 个未选中的 Items\n")
    
    -- 替换媒体路径为 Audio/文件名
    reaper.ShowConsoleMsg("替换媒体路径...\n")
    local replacedCount = 0
    
    for origPath, newPath in pairs(pathMapping) do
        local baseName = string.match(origPath, "([^/\\]+)$")
        -- 搜索所有可能出现在 RPP 中的路径格式
        local pathVariants = { origPath, "Audio/" .. baseName, "Audio\\" .. baseName, baseName }
        
        for _, variant in ipairs(pathVariants) do
            local escaped = variant:gsub("([%(%)%.%+%-%*%?%[%^%$%%])", "%%%1")
            escaped = escaped:gsub("\\", "\\\\")
            local pattern = '(FILE%s+")' .. escaped .. '(")'
            local replaced, count = string.gsub(content, pattern, '%1' .. newPath .. '%2')
            if count > 0 then
                content = replaced
                replacedCount = replacedCount + count
            end
        end
    end

    -- Windows RPP FILE lines often contain single backslashes. The pattern
    -- replacement above can miss those paths, so rewrite FILE entries by
    -- parsing the quoted value and matching normalized path variants.
    local filePathLookup = {}
    for origPath, newPath in pairs(pathMapping) do
        local baseName = string.match(origPath, "([^/\\]+)$")
        local slashPath = origPath:gsub("\\", "/")
        local backslashPath = origPath:gsub("/", "\\")
        filePathLookup[origPath] = newPath
        filePathLookup[slashPath] = newPath
        filePathLookup[backslashPath] = newPath
        if baseName then
            filePathLookup[baseName] = newPath
            filePathLookup["Audio/" .. baseName] = newPath
            filePathLookup["Audio\\" .. baseName] = newPath
        end
    end

    content = content:gsub('(FILE%s+")([^"]-)(")', function(prefix, filePath, suffix)
        local normalized = filePath:gsub("\\", "/")
        local backslashed = filePath:gsub("/", "\\")
        local baseName = string.match(filePath, "([^/\\]+)$")
        local replacement =
            filePathLookup[filePath] or
            filePathLookup[normalized] or
            filePathLookup[backslashed] or
            (baseName and filePathLookup[baseName])
        if replacement then
            replacedCount = replacedCount + 1
            return prefix .. replacement .. suffix
        end
        return prefix .. filePath .. suffix
    end)
    reaper.ShowConsoleMsg("共替换 " .. replacedCount .. " 处路径\n")
    
    -- 将剩余的相对媒体路径转为绝对路径（避免渲染时弹出"丢失媒体"对话框）
    local currentProjDir2 = GetDirectoryPath(currentProjPath)
    if currentProjDir2 and currentProjDir2 ~= "" then
        content = content:gsub('(FILE%s+")([^"]-)"', function(prefix, filePath)
            -- 跳过已经是绝对路径或已经是 Audio/ 开头的
            if filePath:match("^/") or filePath:match("^[A-Za-z]:") or filePath:match("^\\\\") or filePath:match("^Audio/") or filePath:match("^Audio\\") then
                return prefix .. filePath .. '"'
            end
            -- 将相对路径转为绝对路径
            local absPath = currentProjDir2 .. "/" .. filePath
            if IsWindows() then
                absPath = currentProjDir2 .. "\\" .. filePath:gsub("/", "\\")
            end
            return prefix .. absPath .. '"'
        end)
        reaper.ShowConsoleMsg("已将剩余相对路径转为绝对路径\n")
    end

    -- 设置渲染参数（OGG 格式，按时间选区渲染）
    if renderPreview then
        reaper.ShowConsoleMsg("设置渲染参数 (OGG)...\n")
        
        local renderDir = outputDir:gsub("\\", "/")
        local actualStartTime, actualEndTime, previewClamped = ClampPreviewEndTime(startTime or 0, endTime or 0)
        
        reaper.ShowConsoleMsg("  RENDER_FILE (目录): " .. renderDir .. "\n")
        reaper.ShowConsoleMsg("  RENDER_PATTERN (文件名): " .. capsuleName .. "\n")
        reaper.ShowConsoleMsg("  时间范围: " .. string.format("%.6f - %.6f", actualStartTime, actualEndTime) .. "\n")
        if previewClamped then
            reaper.ShowConsoleMsg("  预览已限制为最长 " .. MAX_PREVIEW_SECONDS .. " 秒\n")
        end
        
        -- 先删除所有旧的渲染相关设置
        content = content:gsub('RENDER_FILE [^\n]*\n?', '')
        content = content:gsub('RENDER_PATTERN [^\n]*\n?', '')
        content = content:gsub('RENDER_FMT%s+[^\n]*\n?', '')
        content = content:gsub('RENDER_RANGE%s+[^\n]*\n?', '')
        content = content:gsub('RENDER_STEMS%s+[^\n]*\n?', '')
        
        -- 删除所有旧的 RENDER_CFG 块（避免格式冲突）
        content = content:gsub('%s*<RENDER_CFG%s*\n%s*[%w%+%/=]+%s*\n%s*>', '')
        
        -- 删除旧的渲染设置（可能散布在文件中）
        content = content:gsub('RENDER_1X%s+[^\n]*\n?', '')
        content = content:gsub('RENDER_RESAMPLE%s+[^\n]*\n?', '')
        content = content:gsub('RENDER_ADDTOPROJ%s+[^\n]*\n?', '')
        content = content:gsub('RENDER_DITHER%s+[^\n]*\n?', '')
        content = content:gsub('RENDER_TRIM%s+[^\n]*\n?', '')
        
        -- 构建顶部渲染设置块（不包含 RENDER_CFG，那个放在 SAMPLERATE 后面）
        -- RENDER_RANGE 2 = 时间选区，后两参为 start/end，必须与 SELECTION 一致
        local render1x = hasMidiItems and 2 or 0
        local renderSettings = string.format([[RENDER_FILE %s
RENDER_PATTERN %s
RENDER_FMT 0 2 44100
RENDER_RANGE 2 %.6f %.6f 0 1000
RENDER_STEMS 0
RENDER_1X %d
]], QuoteRppValue(renderDir), QuoteRppValue(capsuleName), actualStartTime, actualEndTime, render1x)
        
        -- 在 REAPER_PROJECT 行后插入渲染设置
        content = content:gsub('(<REAPER_PROJECT[^\n]*\n)', '%1' .. renderSettings)
        
        -- 在 SAMPLERATE 行后插入 RENDER_CFG 块
        local renderCfgBlock = [[
  <RENDER_CFG
    dmdnbwAAAD8AgAAAAIAAAAAgAAAAAAEAAA==
  >]]
        content = content:gsub('(SAMPLERATE%s+[^\n]+\n)', '%1' .. renderCfgBlock .. '\n')
        
        -- 替换 SELECTION 和 SELECTION2（在 PLAYRATE 之后的位置）
        local selectionStr = string.format("SELECTION %.6f %.6f", actualStartTime, actualEndTime)
        local selection2Str = string.format("SELECTION2 %.6f %.6f", actualStartTime, actualEndTime)
        
        if content:match("SELECTION2%s+[%d%.%-]+%s+[%d%.%-]+") then
            content = content:gsub("SELECTION2%s+[%d%.%-]+%s+[%d%.%-]+", selection2Str)
        end
        if content:match("SELECTION%s+[%d%.%-]+%s+[%d%.%-]+") then
            content = content:gsub("SELECTION%s+[%d%.%-]+%s+[%d%.%-]+", selectionStr)
        end
        
        reaper.ShowConsoleMsg("  时间选择: " .. selectionStr .. "\n")
        
        -- 设置 RECORD_PATH 为 Audio
        if content:match('RECORD_PATH "[^"]*"') then
            content = content:gsub('RECORD_PATH "[^"]*"', 'RECORD_PATH "Audio"')
        end
        
        reaper.ShowConsoleMsg("  ✓ 渲染参数设置完成\n")
    end
    
    -- 不写入 VZOOMEX，REAPER 会自动使用默认（归零）纵向滚动
    content = content:gsub("VZOOMEX%s+[^\n]*\n?", "")
    
    -- 写入新 RPP
    local targetRPP = JoinPath(outputDir, capsuleName .. ".rpp")
    reaper.ShowConsoleMsg("写入新 RPP: " .. targetRPP .. "\n")
    
    local targetFile = io.open(targetRPP, "w")
    if not targetFile then
        reaper.ShowConsoleMsg("✗ 无法写入新 RPP\n")
        -- 清理临时文件
        if tempRppPath then
            os.remove(tempRppPath)
        end
        return nil
    end
    targetFile:write(content)
    targetFile:close()
    
    -- 清理临时文件
    if tempRppPath then
        os.remove(tempRppPath)
        reaper.ShowConsoleMsg("✓ 已清理临时 RPP 文件\n")
    end
    
    reaper.ShowConsoleMsg("✓ RPP 生成成功\n")
    return targetRPP
end

-- 生成 metadata.json（新版本 - 不切换工程）
-- 生成 UUID
local function generateUUID()
    math.randomseed(os.time() + os.clock() * 1000000)
    local template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    return string.gsub(template, '[xy]', function(c)
        local v = (c == 'x') and math.random(0, 0xf) or math.random(8, 0xb)
        return string.format('%x', v)
    end)
end

function GenerateCapsuleMetadata(outputDir, capsuleName, capsuleType, itemsInfo, mediaFiles, failedFiles)
    reaper.ShowConsoleMsg("\n=== 生成 metadata.json ===\n")
    
    -- 生成 UUID
    local uuid = generateUUID()
    
    -- 收集信息
    local startTime = math.huge
    local endTime = 0
    for _, info in ipairs(itemsInfo) do
        if info.position < startTime then startTime = info.position end
        if info.position + info.length > endTime then endTime = info.position + info.length end
    end
    
    local duration = endTime - startTime
    local mediaCount = 0
    for _ in pairs(mediaFiles) do mediaCount = mediaCount + 1 end
    local failedCount = #failedFiles
    
    -- 扫描插件信息
    local plugins = ScanPlugins()
    local routingInfo = GetRoutingInfo()
    
    -- 获取工程信息
    local ret, bpm = reaper.GetSetProjectInfo(0, "P_PROJECT_BPM", 0, false)
    if not ret or bpm == nil or bpm == 0 then
        bpm = 120  -- 默认值
    end
    
    local ret2, sampleRate = reaper.GetSetProjectInfo(0, "P_PROJECT_SRATE", 0, false)
    if not ret2 or sampleRate == nil or sampleRate == 0 then
        sampleRate = 48000  -- 默认值
    end
    
    -- 构建插件列表 JSON
    local pluginListJson = ""
    for i, plugin in ipairs(plugins) do
        if i > 1 then
            pluginListJson = pluginListJson .. ", "
        end
        pluginListJson = pluginListJson .. string.format('"%s"', EscapeJSON(plugin))
    end
    
    -- 构建 JSON（使用 "id" 字段，与 Mac 版保持一致）
    local json = string.format([[{
  "id": "%s",
  "name": "%s",
  "capsule_type": "%s",
  "created_at": "%s",
  "info": {
    "bpm": %.1f,
    "length": %.2f,
    "sample_rate": %d,
    "item_count": %d,
    "media_count": %d,
    "external_media_count": %d
  },
  "plugins": {
    "list": [%s],
    "count": %d
  },
  "routing_info": {
    "has_sends": %s,
    "has_folder_bus": %s,
    "tracks_included": %d
  },
  "rpp_file": "%s.rpp",
  "preview_audio": "%s.ogg"
}]], 
        uuid,
        capsuleName,
        capsuleType or "magic",
        os.date("%Y-%m-%dT%H:%M:%S"),
        bpm,
        duration,
        sampleRate,
        #itemsInfo,
        mediaCount,
        failedCount,
        pluginListJson,
        #plugins,
        tostring(routingInfo.has_sends),
        tostring(routingInfo.has_folder_bus),
        routingInfo.tracks_included,
        capsuleName,
        capsuleName
    )
    
    -- 写入文件
    local metadataPath = JoinPath(outputDir, "metadata.json")
    local file = io.open(metadataPath, "w")
    if file then
        file:write(json)
        file:close()
        reaper.ShowConsoleMsg("✓ metadata.json 生成成功\n")
        return true
    else
        reaper.ShowConsoleMsg("✗ 无法写入 metadata.json\n")
        return false
    end
end

-- ============================================================
-- 旧版函数（保留兼容性）
-- ============================================================

-- 收集当前项目中所有媒体文件的绝对路径（使用 REAPER API）
function CollectMediaFilesFromProject()
    local mediaFiles = {}  -- {absolutePath = baseName}
    local _, currentProjPath = reaper.EnumProjects(-1, "")
    local currentProjDir = GetDirectoryPath(currentProjPath)
    local sourceMediaFolder = GetProjectMediaFolderName()
    
    reaper.ShowConsoleMsg("=== 收集媒体文件 ===\n")
    reaper.ShowConsoleMsg("当前工程: " .. (currentProjPath or "未知") .. "\n")
    reaper.ShowConsoleMsg("工程目录: " .. (currentProjDir or "未知") .. "\n")
    reaper.ShowConsoleMsg("媒体文件夹: " .. sourceMediaFolder .. "\n")
    
    local trackCount = reaper.CountTracks(0)
    for i = 0, trackCount - 1 do
        local track = reaper.GetTrack(0, i)
        if track then
            local itemCount = reaper.CountTrackMediaItems(track)
            for j = 0, itemCount - 1 do
                local item = reaper.GetTrackMediaItem(track, j)
                local takeCount = reaper.CountTakes(item)
                for k = 0, takeCount - 1 do
                    local take = reaper.GetTake(item, k)
                    if take then
                        local source = reaper.GetMediaItemTake_Source(take)
                        if source then
                            local retval, fileName = reaper.GetMediaSourceFileName(source, "")
                            if retval and fileName and fileName ~= "" and fileName ~= "?" then
                                -- 检查是否是绝对路径
                                local isAbsolute = string.match(fileName, "^/") or string.match(fileName, "^[A-Za-z]:")
                                local fullPath = nil
                                
                                if isAbsolute then
                                    fullPath = fileName
                                else
                                    -- 相对路径：使用当前工程的媒体文件夹名 + audio/Audio 解析
                                    local testPaths = {
                                        JoinPath(currentProjDir, sourceMediaFolder, fileName),
                                        JoinPath(currentProjDir, fileName),
                                        JoinPath(currentProjDir, "audio", fileName),
                                        JoinPath(currentProjDir, "Audio", fileName),
                                    }
                                    for _, testPath in ipairs(testPaths) do
                                        local f = io.open(testPath, "r")
                                        if f then
                                            f:close()
                                            fullPath = testPath
                                            break
                                        end
                                    end
                                end
                                
                                -- 验证文件存在并添加到列表
                                if fullPath then
                                    local f = io.open(fullPath, "r")
                                    if f then
                                        f:close()
                                        local baseName = string.match(fullPath, "([^/\\]+)$") or fullPath
                                        if not mediaFiles[fullPath] then
                                            mediaFiles[fullPath] = baseName
                                            reaper.ShowConsoleMsg("  ✓ " .. baseName .. " -> " .. fullPath .. "\n")
                                        end
                                    end
                                end
                            end
                        end
                    end
                end
            end
        end
    end
    
    local count = 0
    for _ in pairs(mediaFiles) do count = count + 1 end
    reaper.ShowConsoleMsg("共找到 " .. count .. " 个媒体文件\n")
    
    return mediaFiles
end

-- 保存工程并复制媒体文件到指定路径（Windows 优化版）
function SaveProjectWithMedia(targetPath)
    reaper.ShowConsoleMsg("\n=== SaveProjectWithMedia (Windows) ===\n")
    reaper.ShowConsoleMsg("目标路径: " .. targetPath .. "\n")

    -- 在覆盖 RECORD_PATH 之前读取当前工程的媒体文件夹名（用于后续 RPP 中相对路径替换）
    local sourceMediaFolder = GetProjectMediaFolderName()
    reaper.ShowConsoleMsg("当前工程媒体文件夹: " .. sourceMediaFolder .. "\n")

    -- 获取项目目录（跨平台）
    local projectDir = GetDirectoryPath(targetPath)

    -- 创建项目目录和 Audio 子目录
    if projectDir ~= "" then
        MakeDir(projectDir)
        MakeDir(JoinPath(projectDir, "Audio"))
    end
    
    -- 获取当前工程路径（用于后续路径解析）
    local _, currentProjPath = reaper.EnumProjects(-1, "")
    reaper.ShowConsoleMsg("原始工程: " .. (currentProjPath or "未知") .. "\n")

    -- ★ 关键步骤 1：先收集所有媒体文件（在保存之前）
    local mediaFiles = CollectMediaFilesFromProject()
    
    -- ★ 关键步骤 2：复制媒体文件到 Audio 目录
    local audioDir = JoinPath(projectDir, "Audio")
    local copiedCount = 0
    local copiedFiles = {}  -- 记录复制成功的文件 {baseName = true}
    
    reaper.ShowConsoleMsg("\n=== 复制媒体文件到 " .. audioDir .. " ===\n")
    for sourcePath, baseName in pairs(mediaFiles) do
        local targetMediaPath = JoinPath(audioDir, baseName)
        
        reaper.ShowConsoleMsg("复制: " .. baseName .. "\n")
        reaper.ShowConsoleMsg("  从: " .. sourcePath .. "\n")
        reaper.ShowConsoleMsg("  到: " .. targetMediaPath .. "\n")
        
        CopyFile(sourcePath, targetMediaPath)
        
        -- 验证复制是否成功
        local f = io.open(targetMediaPath, "r")
        if f then
            f:close()
            reaper.ShowConsoleMsg("  ✓ 成功\n")
            copiedCount = copiedCount + 1
            copiedFiles[baseName] = true
        else
            reaper.ShowConsoleMsg("  ✗ 失败\n")
        end
    end
    
    local totalFiles = 0
    for _ in pairs(mediaFiles) do totalFiles = totalFiles + 1 end
    reaper.ShowConsoleMsg("媒体文件复制完成: " .. copiedCount .. "/" .. totalFiles .. "\n")
    
    -- ★ 关键步骤 3：使用 Main_SaveProjectEx 保存项目到新位置
    reaper.ShowConsoleMsg("\n=== 保存项目 ===\n")
    
    -- 设置 RECORD_PATH 为 Audio 文件夹
    reaper.GetSetProjectInfo_String(0, "RECORD_PATH", "Audio", true)
    
    -- 使用 Main_SaveProjectEx 保存到指定路径（0 = 不弹出对话框）
    local saveResult = reaper.Main_SaveProjectEx(0, targetPath, 0)
    reaper.ShowConsoleMsg("保存结果: " .. tostring(saveResult) .. "\n")
    
    -- 如果 Main_SaveProjectEx 失败或不可用，使用备用方案
    if not saveResult then
        reaper.ShowConsoleMsg("Main_SaveProjectEx 失败，使用备用方案...\n")
        -- 读取当前项目内容
        local sourceFile = io.open(currentProjPath, "r")
        if sourceFile then
            local content = sourceFile:read("*all")
            sourceFile:close()
            
            -- 写入目标路径
            local targetFile = io.open(targetPath, "w")
            if targetFile then
                targetFile:write(content)
                targetFile:close()
                reaper.ShowConsoleMsg("备用方案: 已复制 RPP 文件\n")
            end
        end
    end
    
    -- ★ 关键步骤 4：更新 RPP 文件中的路径为相对路径 Audio/文件名（使用开头保存的 sourceMediaFolder）
    reaper.ShowConsoleMsg("\n=== 更新 RPP 文件中的媒体路径 ===\n")
    local rppFile = io.open(targetPath, "r")
    if rppFile then
        local content = rppFile:read("*all")
        rppFile:close()
        local modified = false
        
        for sourcePath, baseName in pairs(mediaFiles) do
            -- 替换绝对路径为相对路径 Audio/文件名
            local escapedPath = string.gsub(sourcePath, "([%(%)%.%+%-%*%?%[%^%$%%])", "%%%1")
            escapedPath = string.gsub(escapedPath, "\\", "\\\\")
            local relativePath = "Audio/" .. baseName
            local newContent = string.gsub(content, escapedPath, relativePath)
            if newContent ~= content then
                content = newContent
                modified = true
                reaper.ShowConsoleMsg("  更新: " .. baseName .. " -> " .. relativePath .. "\n")
            end
            -- 若 RPP 里是用户工程的相对路径（如 Media\xxx 或 Media/xxx），也替换为 Audio/文件名，避免打开临时工程时报丢失媒体
            if sourceMediaFolder ~= "Audio" then
                local escFolder = string.gsub(sourceMediaFolder, "([%(%)%.%+%-%*%?%[%^%$%%])", "%%%1")
                local escBase = string.gsub(baseName, "([%(%)%.%+%-%*%?%[%^%$%%])", "%%%1")
                for _, sep in ipairs({ "\\\\", "/" }) do  -- 反斜杠在 pattern 中要写成 \\\\
                    local oldRel = escFolder .. sep .. escBase
                    local newContent2 = string.gsub(content, oldRel, relativePath)
                    if newContent2 ~= content then
                        content = newContent2
                        modified = true
                        reaper.ShowConsoleMsg("  更新相对路径: " .. sourceMediaFolder .. (sep == "\\\\" and "\\" or sep) .. baseName .. " -> " .. relativePath .. "\n")
                    end
                end
            end
        end
        
        -- 如果内容被修改，写回文件
        if modified then
            rppFile = io.open(targetPath, "w")
            if rppFile then
                rppFile:write(content)
                rppFile:close()
                reaper.ShowConsoleMsg("✓ 已更新 RPP 文件中的媒体路径\n")
            end
        else
            reaper.ShowConsoleMsg("  (无需更新，路径已是相对路径)\n")
        end
    end
    
    reaper.ShowConsoleMsg("=== SaveProjectWithMedia 完成 ===\n\n")
    return true
end

-- 修剪工程：删除时间范围外的Item（或删除非目标Item）
function PruneItems(startTime, endTime, targetItem)
    local trackCount = reaper.CountTracks(0)
    
    -- 如果指定了目标Item，只保留该Item，删除其他所有Item
    if targetItem ~= nil then
        for i = 0, trackCount - 1 do
            local track = reaper.GetTrack(0, i)
            local itemCount = reaper.CountTrackMediaItems(track)
            
            -- 倒序遍历该轨道上的所有Item
            for j = itemCount - 1, 0, -1 do
                local item = reaper.GetTrackMediaItem(track, j)
                
                -- 如果Item不是目标Item，删除它
                if item ~= targetItem then
                    reaper.DeleteTrackMediaItem(track, item)
                end
            end
        end
    else
        -- 如果没有指定目标Item，则按时间范围删除
        for i = 0, trackCount - 1 do
            local track = reaper.GetTrack(0, i)
            local itemCount = reaper.CountTrackMediaItems(track)
            
            -- 倒序遍历该轨道上的所有Item
            for j = itemCount - 1, 0, -1 do
                local item = reaper.GetTrackMediaItem(track, j)
                local itemStart = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
                local itemEnd = itemStart + reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
                
                -- 如果Item不在时间范围内，删除它
                if itemEnd < startTime or itemStart > endTime then
                    reaper.DeleteTrackMediaItem(track, item)
                end
            end
        end
    end
end

-- 收集选中 items 相关的所有轨道
function CollectRelatedTracks()
    local relatedTracks = {}  -- 用于去重
    local numItems = reaper.CountSelectedMediaItems(0)
    
    for i = 0, numItems - 1 do
        local item = reaper.GetSelectedMediaItem(0, i)
        if item then
            local track = reaper.GetMediaItemTrack(item)
            if track then
                -- 添加 item 所在轨道
                relatedTracks[track] = true
                
                -- 添加父轨道链
                local parent = reaper.GetParentTrack(track)
                while parent do
                    relatedTracks[parent] = true
                    parent = reaper.GetParentTrack(parent)
                end
                
                -- 添加 Send 目标轨道（递归）
                local queue = {track}
                local processed = {[track] = true}
                
                while #queue > 0 do
                    local currentTrack = table.remove(queue, 1)
                    local sendCount = reaper.GetTrackNumSends(currentTrack, 0)
                    
                    for j = 0, sendCount - 1 do
                        local destTrack = reaper.GetTrackSendInfo_Value(currentTrack, 0, j, "P_DESTTRACK")
                        if destTrack and not processed[destTrack] then
                            relatedTracks[destTrack] = true
                            processed[destTrack] = true
                            table.insert(queue, destTrack)
                        end
                    end
                end
            end
        end
    end
    
    return relatedTracks
end

-- 扫描选中 items 相关轨道的插件（精确版本）
function ScanPlugins()
    local plugins = {}
    local relatedTracks = CollectRelatedTracks()
    local seenPlugins = {}  -- 用于去重
    
    for track, _ in pairs(relatedTracks) do
        if track ~= nil then
            local fxCount = reaper.TrackFX_GetCount(track)
            
            for j = 0, fxCount - 1 do
                local _, fxName = reaper.TrackFX_GetFXName(track, j, "")
                if fxName ~= "" then
                    -- 提取插件名称（去掉VST/VST3/AAX等前缀）
                    local pluginName = string.match(fxName, "([^:]+)$") or fxName
                    -- 去重
                    if not seenPlugins[pluginName] then
                        seenPlugins[pluginName] = true
                        table.insert(plugins, pluginName)
                    end
                end
            end
        end
    end
    
    return plugins
end

-- 检查选中 items 相关轨道的路由信息
function GetRoutingInfo()
    local routingInfo = {
        has_sends = false,
        has_folder_bus = false,
        tracks_included = 0
    }
    
    local relatedTracks = CollectRelatedTracks()
    
    -- 计算相关轨道数
    for _ in pairs(relatedTracks) do
        routingInfo.tracks_included = routingInfo.tracks_included + 1
    end
    
    for track, _ in pairs(relatedTracks) do
        if track ~= nil then
            -- 检查是否有Send
            if reaper.GetTrackNumSends(track, 0) > 0 then
                routingInfo.has_sends = true
            end
            
            -- 检查是否是文件夹（有子轨道）
            local parentTrack = reaper.GetParentTrack(track)
            if parentTrack ~= nil then
                routingInfo.has_folder_bus = true
            end
        end
    end
    
    return routingInfo
end

-- 转义JSON字符串
function EscapeJSON(str)
    str = string.gsub(str, "\\", "\\\\")
    str = string.gsub(str, '"', '\\"')
    str = string.gsub(str, "\n", "\\n")
    str = string.gsub(str, "\r", "\\r")
    str = string.gsub(str, "\t", "\\t")
    return str
end

-- 生成JSON元数据
function GenerateMetadata(itemName, startTime, endTime, plugins, routingInfo, outputDir, rppFileName)
    -- 获取工程信息
    local ret, bpm = reaper.GetSetProjectInfo(0, "P_PROJECT_BPM", 0, false)
    if not ret or bpm == nil or bpm == 0 then
        bpm = 120  -- 默认值
    end
    
    local ret2, sampleRate = reaper.GetSetProjectInfo(0, "P_PROJECT_SRATE", 0, false)
    if not ret2 or sampleRate == nil or sampleRate == 0 then
        sampleRate = 48000  -- 默认值
    end
    
    local length = endTime - startTime
    
    -- 构建插件列表JSON
    local pluginList = ""
    for i, plugin in ipairs(plugins) do
        if i > 1 then
            pluginList = pluginList .. ", "
        end
        pluginList = pluginList .. string.format('"%s"', EscapeJSON(plugin))
    end
    if #plugins == 0 then
        pluginList = ""
    end
    
    -- 检查是否存在预览文件
    -- Reaper 使用 RENDER_PATTERN 会生成 "{胶囊名}.ogg" 格式的文件
    local previewFileName = nil

    -- 尝试多种可能的预览文件名和位置
    local possibleNames = {
        {name = itemName .. ".ogg", subdir = ""},                       -- 胶囊名.ogg（新格式）
        {name = itemName .. "_preview.ogg", subdir = ""},              -- 胶囊名_preview.ogg（旧格式）
        {name = itemName .. "_preview.ogg", subdir = "preview.wav"},  -- 在 preview.wav 子目录中（旧格式兼容）
        {name = "preview.ogg", subdir = "preview.wav"},                 -- 在 preview.wav 子目录中
        {name = "preview.ogg", subdir = ""},                            -- 固定名称
        {name = itemName .. "_preview.mp3", subdir = ""},              -- MP3 格式
        {name = "preview.mp3", subdir = ""}                             -- 固定 MP3
    }

    for _, item in ipairs(possibleNames) do
        local name = item.name
        local subdir = item.subdir
        -- 使用跨平台 JoinPath
        local testPath
        if subdir ~= "" then
            testPath = JoinPath(outputDir, subdir, name)
        else
            testPath = JoinPath(outputDir, name)
        end
        local testFile = io.open(testPath, "r")
        if testFile then
            testFile:close()
            -- 如果文件在子目录中，保存相对路径（使用跨平台分隔符）
            local sep = IsWindows() and "\\" or "/"
            previewFileName = (subdir ~= "" and subdir .. sep or "") .. name
            reaper.ShowConsoleMsg("  找到预览文件: " .. previewFileName .. "\n")
            break
        end
    end
    
    -- 构建JSON字符串
    local filesSection = ""
    local actualRppFileName = rppFileName or "source.rpp"
    if previewFileName then
        filesSection = string.format('  "files": {\n    "preview": "%s",\n    "project": "%s"\n  },', previewFileName, actualRppFileName)
    else
        filesSection = string.format('  "files": {\n    "project": "%s"\n  },', actualRppFileName)
    end

    -- 构建顶部预览字段（如果存在预览文件）
    local previewSection = ""
    if previewFileName then
        previewSection = string.format('  "preview_audio": "%s",\n', previewFileName)
    end

    local json = string.format([[
{
  "id": "%s",
  "name": "%s",
%s
%s
  "info": {
    "bpm": %.1f,
    "length": %.2f,
    "sample_rate": %d
  },
  "plugins": {
    "list": [%s],
    "count": %d
  },
  "routing_info": {
    "has_sends": %s,
    "has_folder_bus": %s,
    "tracks_included": %d
  }
}
]],
        GenerateUUID(),
        EscapeJSON(itemName),
        previewSection,
        filesSection,
        bpm,
        length,
        sampleRate,
        pluginList,
        #plugins,
        tostring(routingInfo.has_sends),
        tostring(routingInfo.has_folder_bus),
        routingInfo.tracks_included
    )
    
    -- 写入文件
    local jsonPath = outputDir .. "/metadata.json"
    local file = io.open(jsonPath, "w")
    if file then
        file:write(json)
        file:close()
        return true
    else
        reaper.ShowConsoleMsg("错误：无法写入 metadata.json\n")
        return false
    end
end

-- 创建临时渲染预设文件（基于用户的OGG预设）
function CreateTempRenderPreset(rppPath, outputPath, startTime, endTime)
    -- 预设文件路径（放在输出目录中）
    local outputDir = GetDirectoryPath(outputPath)
    local presetPath = outputDir .. "/_temp_render_preset.ini"
    
    -- 从用户的预设文件中提取关键设置
    -- 格式参考：
    -- <RENDERPRESET preset_name sample_rate format ...>
    -- RENDERPRESET_OUTPUT preset_name range_type start_time end_time ... output_path ...
    
    -- 预设名称（使用唯一名称避免冲突）
    local presetName = "capsule_render_" .. os.time()
    
    -- 构建预设内容
    -- RENDERPRESET 行：preset_name, sample_rate(48000), format(2=OGG), ...
    -- 注意：格式值 2 表示 OGG Vorbis
    local presetContent = string.format([[
<RENDERPRESET %s 48000 2 0 1 9 0 0
  dmdnbwAAAD8AgAAAAIAAAAAgAAAAAAEAAA==
>
RENDERPRESET_OUTPUT %s 2 %.3f %.3f 0 0 $project_preview 0 %s 1000 0
]], 
        presetName,
        presetName,
        startTime,
        endTime,
        outputPath
    )
    
    -- 写入预设文件
    local presetFile = io.open(presetPath, "w")
    if presetFile then
        presetFile:write(presetContent)
        presetFile:close()
        reaper.ShowConsoleMsg("  创建临时预设文件: " .. presetPath .. "\n")
        return presetPath, presetName
    else
        reaper.ShowConsoleMsg("  ✗ 无法创建预设文件: " .. presetPath .. "\n")
        return nil, nil
    end
end

-- 创建临时渲染脚本（使用预设）
function CreateTempRenderScript(rppPath, outputPath, presetPath, presetName, startTime, endTime)
    local scriptPath = outputPath .. "_render_script.lua"
    local scriptDir = GetDirectoryPath(scriptPath)
    
    -- 创建临时目录（如果需要，跨平台）
    if scriptDir ~= "" then
        MakeDir(scriptDir)
    end
    
    -- 从输出路径提取时间范围（如果提供了）
    local renderStartTime = startTime or 0
    local renderEndTime = endTime or 0
    
    local scriptContent = string.format([[
-- 临时渲染脚本（自动生成）
-- 打开项目
reaper.Main_openProject("%s")

-- 等待项目加载
reaper.UpdateTimeline()
reaper.defer(function() end)  -- 确保项目完全加载

-- 设置时间选择范围
local startTime = %.3f
local endTime = %.3f
reaper.GetSet_LoopTimeRange(true, false, startTime, endTime, false)

-- 设置渲染输出路径
local outputPath = "%s"
reaper.GetSetProjectInfo_String(0, "RENDER_FILE", outputPath, true)

-- 设置渲染范围：时间选择
reaper.GetSetProjectInfo(0, "RENDER_RANGE", 1, false)

-- 设置渲染源：Master mix
reaper.GetSetProjectInfo(0, "RENDER_STEMS", 136, false)

-- 方法1: 尝试使用 RenderProject_Table API（最可靠的方法）
if reaper.RenderProject_Table then
    reaper.ShowConsoleMsg("使用 RenderProject_Table API 进行渲染...\n")
    local success, ret = reaper.RenderProject_Table(
        nil,  -- project (nil = current)
        2,    -- renderBounds (2 = time selection)
        startTime,
        endTime,
        1.0,  -- playRate
        outputPath,
        0,    -- tailLength (ms)
        1,    -- tailFlag (1 = with tail)
        true  -- closeAfterRender
    )
    if success and ret then
        reaper.ShowConsoleMsg("✓ 渲染成功: " .. outputPath .. "\n")
        os.exit(0)
    else
        reaper.ShowConsoleMsg("✗ RenderProject_Table 失败，尝试其他方法...\n")
    end
end

-- 方法2: 尝试使用 RenderProject API
if reaper.RenderProject then
    reaper.ShowConsoleMsg("使用 RenderProject API 进行渲染...\n")
    -- 需要先设置渲染格式（OGG）
    -- 注意：RenderProject 可能需要先配置格式
    local ret = reaper.RenderProject(nil, false, true, outputPath)
    if ret > 0 then
        reaper.ShowConsoleMsg("✓ 渲染成功: " .. outputPath .. "\n")
        os.exit(0)
    else
        reaper.ShowConsoleMsg("✗ RenderProject 失败，尝试使用命令...\n")
    end
end

-- 方法3: 使用预设文件（如果提供了）
]], rppPath, renderStartTime, renderEndTime, outputPath)
    
    -- 如果提供了预设路径和名称，添加预设文件加载代码
    if presetPath and presetPath ~= "" and presetName and presetName ~= "" then
        scriptContent = scriptContent .. string.format([[
local presetFile = "%s"
local presetExists = io.open(presetFile, "r")
if presetExists then
    presetExists:close()
    -- 将预设文件复制到Reaper的预设目录（跨平台）
    local sep = package.config:sub(1,1)
    local reaperPresetDir = reaper.GetResourcePath() .. sep .. "RenderPresets"
    if sep == "\\" then
        os.execute('if not exist "' .. reaperPresetDir:gsub("/", "\\") .. '" mkdir "' .. reaperPresetDir:gsub("/", "\\") .. '"')
    else
        os.execute('mkdir -p "' .. reaperPresetDir .. '"')
    end
    local presetName = "%s"
    local targetPresetPath = reaperPresetDir .. sep .. presetName .. ".ini"
    if sep == "\\" then
        os.execute('copy /Y "' .. presetFile:gsub("/", "\\") .. '" "' .. targetPresetPath:gsub("/", "\\") .. '" >nul 2>&1')
    else
        os.execute('cp "' .. presetFile .. '" "' .. targetPresetPath .. '"')
    end
    reaper.ShowConsoleMsg("已加载预设文件: " .. presetName .. "\n")
end

-- 方法4: 使用最近一次的渲染设置（备用方法）
reaper.ShowConsoleMsg("使用最近一次的渲染设置...\n")
reaper.Main_OnCommand(42230, 0)  -- 使用最近一次的渲染设置
]], presetPath, presetName)
    else
        scriptContent = scriptContent .. [[
-- 方法4: 使用最近一次的渲染设置（备用方法）
reaper.ShowConsoleMsg("使用最近一次的渲染设置...\n")
reaper.Main_OnCommand(42230, 0)  -- 使用最近一次的渲染设置
]]
    end
    
    scriptContent = scriptContent .. "\n"
    
    scriptContent = scriptContent .. "\n"
    
    -- 写入脚本文件
    local scriptFile = io.open(scriptPath, "w")
    if scriptFile then
        scriptFile:write(scriptContent)
        scriptFile:close()
        return scriptPath
    else
        return nil
    end
end

-- 修复RPP文件中的渲染设置（直接修改文件内容）
function FixRPPRenderSettings(rppPath, outputPath, startTime, endTime, capsuleName)
    reaper.ShowConsoleMsg("修复RPP文件中的渲染设置...\n")

    -- 读取RPP文件内容
    local file = io.open(rppPath, "r")
    if not file then
        reaper.ShowConsoleMsg("  ✗ 无法读取RPP文件\n")
        return false
    end

    local content = file:read("*all")
    file:close()

    -- 检查是否已经修复过（防止重复修改）
    if string.find(content, "dmdnbwAAAD8AgAAAAIAAAAAgAAAAAAEAAA==") then
        reaper.ShowConsoleMsg("  ✓ RENDER_CFG 已经是 OGG 格式，跳过修复\n")
        return true
    end

    local modified = false
    
    -- 1. 修复 RENDER_FILE（替换错误的路径）
    -- 查找并替换所有可能的错误路径模式
    local patterns = {
        'RENDER_FILE%s+"[^"]*preview%.ogg/[^"]*"',  -- preview.ogg/xxx 模式
        'RENDER_FILE%s+\'[^\']*preview%.ogg/[^\']*\'',  -- 单引号模式
        'RENDER_FILE%s+"[^"]*_temp_export[^"]*"',  -- _temp_export 模式
        'RENDER_FILE%s+\'[^\']*_temp_export[^\']*\'',
    }
    
    for _, pattern in ipairs(patterns) do
        local oldContent = content
        content = string.gsub(content, pattern, function(match)
            local newMatch = string.gsub(match, '"[^"]*"', '"' .. outputPath .. '"')
            newMatch = string.gsub(newMatch, "'[^']*'", "'" .. outputPath .. "'")
            modified = true
            reaper.ShowConsoleMsg("  修复 RENDER_FILE: " .. match .. " -> " .. newMatch .. "\n")
            return newMatch
        end)
        if content ~= oldContent then
            break
        end
    end
    
    -- 关键发现：Reaper 命令行渲染需要使用特定的格式
    -- 1. RENDER_FILE 必须指向目录；路径包含空格时必须加引号
    -- 2. 必须有 RENDER_PATTERN $project_preview
    -- 3. RENDER_STEMS 必须是 0（不是 136）

    -- 提取输出目录
    local outputDir = string.match(outputPath, "^(.*)/[^/]*$")

    -- 先删除所有现有的渲染相关设置（避免重复）
    content = string.gsub(content, 'RENDER_FILE%s+[^\n]*\n?', '')
    content = string.gsub(content, 'RENDER_PATTERN%s+[^\n]*\n?', '')
    content = string.gsub(content, 'RENDER_SETTINGS%s+%d+\n?', '')
    content = string.gsub(content, 'RENDER_RANGE%s+[^\n]*\n?', '')
    content = string.gsub(content, 'RENDER_STEMS%s+%d+\n?', '')
    content = string.gsub(content, 'RENDER_1X%s+[^\n]*\n?', '')
    content = string.gsub(content, 'LOOP%s+%d+%.%d+%s+%d+%.%d+\n?', '')  -- 删除时间选择 LOOP

    -- 关键修复：替换 <APPLYFX_CFG> 内的 RENDER_FMT
    -- 这是最重要的，因为 REAPER 优先读取这个设置
    -- 使用字符串查找而不是正则表达式，更可靠
    local _, _, before = string.find(content, "<APPLYFX_CFG")
    local _, fmt_start = string.find(content, "RENDER_FMT", before)
    if fmt_start then
        -- 找到 RENDER_FMT 所在行的开头（从 fmt_start 向前找换行符）
        local line_start = fmt_start
        while line_start > 1 and string.sub(content, line_start - 1, line_start - 1) ~= "\n" do
            line_start = line_start - 1
        end

        local _, fmt_end = string.find(content, "\n", fmt_start)
        if fmt_end then
            local before_fmt = string.sub(content, 1, line_start - 1)
            local after_fmt = string.sub(content, fmt_end)
            content = before_fmt .. "RENDER_FMT 0 2 44100" .. after_fmt
            reaper.ShowConsoleMsg("  ✓ 已更新 APPLYFX_CFG 内的 RENDER_FMT 为 OGG 格式\n")
        end
    else
        reaper.ShowConsoleMsg("  ⚠ 警告：未找到 APPLYFX_CFG 内的 RENDER_FMT\n")
    end

    -- 关键修复：替换 <RENDER_CFG 块为 OGG 格式
    -- 格式：<RENDER_CFG\r\n    BASE64\r\n  >
    -- 需要找到从 <RENDER_CFG 到对应的 > 之间的所有内容

    local render_cfg_start = string.find(content, "<RENDER_CFG")
    if render_cfg_start then
        -- 找到第一个 >（这是块的结束标记）
        local block_end = string.find(content, ">", render_cfg_start)
        if block_end then
            local before_block = string.sub(content, 1, render_cfg_start - 1)
            local after_block = string.sub(content, block_end + 1)

            -- 检查块内容是否已经是 OGG 格式
            local block_content = string.sub(content, render_cfg_start, block_end)
            if string.find(block_content, "dmdnbwAAAD8AgAAAAIAAAAAgAAAAAAEAAA==") then
                reaper.ShowConsoleMsg("  ✓ RENDER_CFG 已经是 OGG 格式，跳过\n")
            else
                -- 替换整个块为 OGG 格式
                local new_block = "<RENDER_CFG\r\n    dmdnbwAAAD8AgAAAAIAAAAAgAAAAAAEAAA==\r\n  >"
                content = before_block .. new_block .. after_block
                reaper.ShowConsoleMsg("  ✓ 已更新 RENDER_CFG 二进制配置为 OGG 格式\n")
            end
        else
            reaper.ShowConsoleMsg("  ⚠ 警告：未找到 RENDER_CFG 块结束标记\n")
        end
    else
        reaper.ShowConsoleMsg("  ⚠ 警告：未找到 RENDER_CFG\n")
    end

    -- 添加正确的渲染设置（在文件开头，<REAPER_PROJECT> 后面）
    -- 关键修改：从 capsuleName 和 outputDir 构建正确的输出路径

    -- 使用胶囊名（不带扩展名）作为 RENDER_PATTERN
    -- capsuleName 格式: type_user_timestamp，可能是纯文件名或包含路径
    -- 提取不带扩展名的文件名（如果 capsuleName 包含路径）
    local baseName = string.match(capsuleName, ".*/([^/]*)$") or capsuleName

    -- 从 capsuleName 中提取输出目录（如果包含路径），否则从 outputPath 提取
    local outputDir_for_render = ""
    if string.match(capsuleName, ".*/") then
        -- capsuleName 包含路径，直接使用
        outputDir_for_render = string.match(capsuleName, "^(.*)/[^/]*$") or ""
    else
        -- capsuleName 只是文件名，从 outputPath 提取目录
        -- 但要注意：outputPath 可能是临时文件路径（如 preview_temp.wav）
        -- 所以我们需要提取其父目录，而不是文件名
        outputDir_for_render = string.match(outputPath, "^(.*)/[^/]*$") or ""
    end

    local hasMidiInProject = content:lower():find("source midi", 1, true) ~= nil
    local render1x = hasMidiInProject and 2 or 0
    local renderSettings = string.format([[
RENDER_FILE %s
RENDER_PATTERN %s
RENDER_FMT 0 2 44100
RENDER_RANGE 2 %.6f %.6f 0 1000
RENDER_STEMS 0
RENDER_1X %d
]], QuoteRppValue(outputDir_for_render), QuoteRppValue(baseName), startTime, endTime, render1x)

    -- 在 <REAPER_PROJECT> 行后插入渲染设置
    content = string.gsub(content, '(<REAPER_PROJECT[^\n]*\n)', '%1' .. renderSettings)
    modified = true

    -- 不写入 VZOOMEX，REAPER 会自动使用默认（归零）纵向滚动
    content = content:gsub("VZOOMEX%s+[^\n]*\n?", "")

    -- 如果内容被修改，写回文件
    if modified then
        file = io.open(rppPath, "w")
        if file then
            file:write(content)
            file:close()
            reaper.ShowConsoleMsg("  ✓ RPP文件渲染设置已修复\n")
            return true
        else
            reaper.ShowConsoleMsg("  ✗ 无法写入RPP文件\n")
            return false
        end
    else
        reaper.ShowConsoleMsg("  ✓ RPP文件渲染设置已正确\n")
        return true
    end
end

-- 从RPP文件渲染预览音频（使用命令行）
function RenderPreviewAudioFromRPP(rppPath, outputPath, startTime, endTime)
    reaper.ShowConsoleMsg("\n[RenderPreviewAudioFromRPP] 函数开始\n")
    reaper.ShowConsoleMsg("  RPP路径: " .. rppPath .. "\n")
    reaper.ShowConsoleMsg("  输出路径: " .. outputPath .. "\n")
    local previewStartTime, previewEndTime, previewClamped = ClampPreviewEndTime(startTime, endTime)
    if previewClamped then
        reaper.ShowConsoleMsg("  预览已限制为最长 " .. MAX_PREVIEW_SECONDS .. " 秒\n")
    end

    -- 检查是否需要 OGG 格式
    local isOggOutput = string.match(outputPath, "%.ogg$")
    local tempWavPath = nil

    reaper.ShowConsoleMsg("  目标格式: " .. (isOggOutput and "OGG" or "WAV") .. "\n")

    if isOggOutput then
        -- 检查 FFmpeg 可用性
        reaper.ShowConsoleMsg("  检查 FFmpeg 可用性...\n")
        local ffmpegAvailable, ffmpegVersion = CheckFFmpegAvailable()
        if not ffmpegAvailable then
            reaper.ShowConsoleMsg("  ✗ FFmpeg 不可用，将输出 WAV 格式\n")
            -- 修改输出路径为 WAV
            tempWavPath = string.gsub(outputPath, "%.ogg$", ".wav")
            outputPath = tempWavPath
        else
            reaper.ShowConsoleMsg("  ✓ FFmpeg 可用\n")
            -- 创建临时 WAV 文件路径
            tempWavPath = string.gsub(outputPath, "%.ogg$", "_temp.wav")
        end
    end

    reaper.ShowConsoleMsg("  临时WAV路径: " .. (tempWavPath or "无") .. "\n")

    -- 检查RPP文件是否存在
    local rppFile = io.open(rppPath, "r")
    if not rppFile then
        reaper.ShowConsoleMsg("  ✗ RPP文件不存在\n")
        return false
    end
    rppFile:close()
    reaper.ShowConsoleMsg("  ✓ RPP文件存在\n")

    -- 获取Reaper可执行文件路径
    local reaperPath = nil

    -- 方法1: 优先检查标准的 macOS 安装路径
    local standardPaths = {
        "/Applications/REAPER.app/Contents/MacOS/REAPER",
        "/Applications/REAPER64.app/Contents/MacOS/REAPER",
        "/Applications/Reaper.app/Contents/MacOS/REAPER",
        "/Applications/Reaper64.app/Contents/MacOS/REAPER",
    }
    for _, testPath in ipairs(standardPaths) do
        local testFile = io.open(testPath, "r")
        if testFile then
            testFile:close()
            reaperPath = testPath
            break
        end
    end

    -- 方法2: 如果标准路径不存在，尝试使用 reaper.GetExePath()
    if not reaperPath or reaperPath == "" then
        if reaper.GetExePath then
            local tempPath = reaper.GetExePath()

            -- 验证路径是否有效
            if tempPath and tempPath ~= "" then
                if not string.match(tempPath, "REAPER$") and not string.match(tempPath, "reaper$") then
                    -- 可能是目录路径，尝试查找可执行文件
                    local appPath = tempPath .. "/REAPER.app/Contents/MacOS/REAPER"
                    local testFile = io.open(appPath, "r")
                    if testFile then
                        testFile:close()
                        reaperPath = appPath
                    else
                        local testPath = tempPath .. "/REAPER"
                        testFile = io.open(testPath, "r")
                        if testFile then
                            testFile:close()
                            reaperPath = testPath
                        end
                    end
                else
                    -- 已经是完整路径，验证是否存在
                    local testFile = io.open(tempPath, "r")
                    if testFile then
                        testFile:close()
                        reaperPath = tempPath
                    end
                end
            end
        end
    end

    if not reaperPath or reaperPath == "" then
        reaper.ShowConsoleMsg("  ✗ 无法找到 REAPER 可执行文件\n")
        return false
    end

    -- 验证Reaper可执行文件是否存在
    local exeFile = io.open(reaperPath, "r")
    if not exeFile then
        reaper.ShowConsoleMsg("  ✗ REAPER 可执行文件不存在: " .. reaperPath .. "\n")
        return false
    end
    exeFile:close()
    reaper.ShowConsoleMsg("  ✓ REAPER路径: " .. reaperPath .. "\n")

    -- 修复RPP文件中的渲染设置（直接修改文件内容）
    if startTime and endTime then
        reaper.ShowConsoleMsg("  修复RPP渲染设置...\n")
        FixRPPRenderSettings(rppPath, tempWavPath or outputPath, previewStartTime, previewEndTime)
    end
    local _, renderBase = SplitOutputPath(tempWavPath or outputPath)
    RewriteRppRenderOutputToCurrentDir(rppPath, renderBase)

    -- 构建渲染命令（添加 -nosplash -ignoreerrors -nonewinst 参数，Windows 用 start /B 后台运行）
    local renderCmd
    if IsWindows() then
        renderCmd = nil
    else
        renderCmd = string.format('"%s" -renderproject "%s" -nosplash -ignoreerrors', reaperPath, rppPath)
    end
    reaper.ShowConsoleMsg("  执行渲染命令:\n")
    reaper.ShowConsoleMsg("    " .. tostring(renderCmd or "windows temporary helper") .. "\n")

    -- 执行命令行渲染
    local result
    if IsWindows() then
        result = RunWindowsBackgroundRender(reaperPath, rppPath, GetDirectoryPath(outputPath), 190000)
    else
        result = RunCommandHidden(renderCmd, 190000)
    end
    reaper.ShowConsoleMsg("  渲染命令返回码: " .. tostring(result) .. "\n")

    -- 等待文件写入完成
    reaper.ShowConsoleMsg("  等待文件写入...\n")
    os.execute("sleep 2")

    -- 检查输出文件是否生成
    local actualOutputPath = tempWavPath or outputPath
    reaper.ShowConsoleMsg("  检查输出文件: " .. actualOutputPath .. "\n")

    local file = io.open(actualOutputPath, "r")
    if file then
        file:close()
        reaper.ShowConsoleMsg("  ✓ 输出文件已生成\n")

        -- 如果需要转换为 OGG
        if tempWavPath and isOggOutput then
            reaper.ShowConsoleMsg("  开始 WAV -> OGG 转换...\n")
            -- 调用转换函数
            local convertSuccess = ConvertWavToOgg(tempWavPath, outputPath)

            if convertSuccess then
                reaper.ShowConsoleMsg("  ✓ OGG 转换成功\n")
                -- 转换成功，删除临时 WAV 文件
                os.execute('rm -f "' .. tempWavPath .. '"')
                return true
            else
                reaper.ShowConsoleMsg("  ✗ OGG 转换失败\n")

                -- 检查是否为自动导出模式
                if _SYNEST_AUTO_EXPORT then
                    -- 自动导出模式：不弹出对话框，保留 WAV 文件
                    reaper.ShowConsoleMsg("  [自动导出] 保留 WAV 格式\n")
                    local finalWavPath = string.gsub(tempWavPath, "_temp%.wav$", ".wav")
                    os.execute('mv "' .. tempWavPath .. '" "' .. finalWavPath .. '"')

                    -- 更新 output.json 中的预览文件名
                    local jsonPath = string.gsub(outputPath, "/preview%.ogg$", "/output.json")
                    local jsonFile = io.open(jsonPath, "r")
                    if jsonFile then
                        local content = jsonFile:read("*a")
                        jsonFile:close()

                        -- 替换 preview.ogg 为 preview.wav
                        content = string.gsub(content, '"preview": "preview%.ogg"', '"preview": "preview.wav"')
                        content = string.gsub(content, '"preview_audio": "preview%.ogg"', '"preview_audio": "preview.wav"')

                        local outFile = io.open(jsonPath, "w")
                        if outFile then
                            outFile:write(content)
                            outFile:close()
                            reaper.ShowConsoleMsg("  ✓ 已更新 output.json 中的文件名\n")
                        end
                    end

                    return true
                else
                    -- 手动模式：弹出对话框
                    local userChoice = reaper.ShowMessageBox(
                        "OGG 转换失败，已生成 WAV 文件。\n\n是否接受 WAV 格式？",
                        "转换失败",
                        4  -- 4 = Yes/No
                    )

                    if userChoice == 6 then  -- 6 = Yes
                        -- 将 WAV 重命名为预期的文件名（去掉 _temp）
                        local finalWavPath = string.gsub(tempWavPath, "_temp%.wav$", ".wav")
                        os.execute('mv "' .. tempWavPath .. '" "' .. finalWavPath .. '"')
                        return true
                    else
                        return false
                    end
                end
            end
        else
            -- 不需要转换，直接返回成功
            reaper.ShowConsoleMsg("  ✓ 无需转换，渲染完成\n")
            return true
        end
    else
        reaper.ShowConsoleMsg("  ✗ 输出文件未生成\n")
        reaper.ShowConsoleMsg("    可能原因: REAPER 渲染失败或时间范围无效\n")
        return false
    end
end

-- 显示用户输入对话框
function ShowExportDialog(defaultName)
    -- 使用更友好的对话框格式
    -- GetUserInputs(title, num_inputs, captions_csv, retvals_csv)
    local title = "导出胶囊设置"
    local inputs = "胶囊名称 (将用作文件夹和RPP文件名):,导出预览音频 (需要FFmpeg):"
    local defaultValues = defaultName .. ",1"
    
    local ret, userInputs = reaper.GetUserInputs(title, 2, inputs, defaultValues)
    
    if not ret then
        -- 用户取消了对话框
        return nil, nil
    end
    
    -- 解析用户输入（用逗号分隔）
    local name = ""
    local exportPreviewStr = "1"
    local fieldIndex = 1
    
    for match in string.gmatch(userInputs, "([^,]+)") do
        if fieldIndex == 1 then
            name = match
            -- 移除首尾空白
            name = string.gsub(name, "^%s+", "")
            name = string.gsub(name, "%s+$", "")
        elseif fieldIndex == 2 then
            exportPreviewStr = string.gsub(match, "^%s+", "")
            exportPreviewStr = string.gsub(exportPreviewStr, "%s+$", "")
        end
        fieldIndex = fieldIndex + 1
    end
    
    -- 如果名称为空，使用默认名称
    if name == "" then
        name = defaultName
    end
    
    -- 清理名称（移除非法字符，保留中文字符和基本字符）
    name = string.gsub(name, "[<>:\"/\\|?*]", "_")  -- 移除Windows/Unix非法字符
    name = string.gsub(name, "^%.+$", "_")  -- 移除纯点号
    name = string.gsub(name, "%s+", "_")  -- 空格替换为下划线
    
    -- 解析是否导出预览
    local exportPreview = (exportPreviewStr == "1" or exportPreviewStr == "是" or 
                           string.lower(exportPreviewStr) == "yes" or 
                           string.lower(exportPreviewStr) == "y" or
                           exportPreviewStr == "true")
    
    return name, exportPreview
end

-- 导出胶囊的主函数
function ExportCapsule()
    BridgePhase("saving capsule: checking selected items")
    -- 1. 锁定目标：识别选中的 Item 及其时间范围
    local itemCount = reaper.CountSelectedMediaItems(0)
    if itemCount == 0 then
        -- 自动导出模式下不弹窗，只记录日志
        if not _SYNEST_AUTO_EXPORT then
            reaper.ShowMessageBox("请先选中至少一个 Audio Item", "提示", 0)
        else
            reaper.ShowConsoleMsg("[自动导出] 错误: 没有选中的 Audio Item\n")
        end
        return false
    end
    
    local selectedItems = {}
    for i = 0, itemCount - 1 do
        local item = reaper.GetSelectedMediaItem(0, i)
        table.insert(selectedItems, item)
    end
    
    local startTime, endTime = GetTimeSelection()
    reaper.ShowConsoleMsg(string.format("时间范围: %.2f - %.2f\n", startTime, endTime))
    
    -- 生成默认名称（基于第一个Item）
    local firstItem = selectedItems[1]
    local defaultName = GetItemName(firstItem)
    if #selectedItems > 1 then
        defaultName = defaultName .. "_and_" .. (#selectedItems - 1) .. "_more"
    end
    defaultName = string.gsub(defaultName, "[^%w_%-]", "_")
    defaultName = string.gsub(defaultName, ",", "_")

    -- 检查是否为自动导出模式（从 Synesth Web UI 触发）
    local capsuleName, exportPreview
    if _SYNEST_AUTO_EXPORT then
        -- 自动导出模式：使用全局变量中的配置，不弹出对话框
        capsuleName = _SYNEST_AUTO_EXPORT.capsule_name
        exportPreview = _SYNEST_AUTO_EXPORT.render_preview
        reaper.ShowConsoleMsg(string.format("[自动导出] 胶囊名称: %s\n", capsuleName))
        reaper.ShowConsoleMsg(string.format("[自动导出] 导出预览: %s\n", exportPreview and "是" or "否"))
    else
        -- 手动导出模式：显示用户输入对话框
        capsuleName, exportPreview = ShowExportDialog(defaultName)
        if capsuleName == nil then
            -- 用户取消了导出
            reaper.ShowConsoleMsg("用户取消导出\n")
            return false
        end
    end
    
    reaper.ShowConsoleMsg(string.format("胶囊名称: %s\n", capsuleName))
    reaper.ShowConsoleMsg(string.format("导出预览: %s\n", exportPreview and "是" or "否"))

    -- 获取当前 REAPER 项目路径（在后面需要用到）
    local _, currentProjectPath = reaper.EnumProjects(-1, "")

    -- 获取输出目录（优先使用配置的导出目录）
    local outputBaseDir = nil

    reaper.ShowConsoleMsg("=== [路径诊断] ===\n")

    -- 1. 优先检查 _SYNEST_AUTO_EXPORT 中的导出目录配置
    if _SYNEST_AUTO_EXPORT and _SYNEST_AUTO_EXPORT.export_dir then
        outputBaseDir = _SYNEST_AUTO_EXPORT.export_dir
        reaper.ShowConsoleMsg("✓ 使用配置的导出目录:\n")
        reaper.ShowConsoleMsg("  路径: " .. outputBaseDir .. "\n")
        reaper.ShowConsoleMsg("  类型: " .. ((outputBaseDir:match("^/") or outputBaseDir:match("^[A-Za-z]:")) and "绝对路径" or "相对路径") .. "\n")
    end

    -- 2. 如果没有配置，尝试环境变量和其他路径
    if not outputBaseDir or outputBaseDir == "" then
        reaper.ShowConsoleMsg("⚠️  未配置导出目录，尝试备用路径...\n")

        local synesthOutputPath = os.getenv("SYNESTH_CAPSULE_OUTPUT") or
                                   reaper.GetResourcePath() .. "/Scripts/Reaper_Sonic_Capsule/output"

        local projectDir = GetDirectoryPath(currentProjectPath)

        -- 尝试多个可能的 Synesth 项目路径
        local possiblePaths = {
            "/Users/ianzhao/Desktop/Sound_Capsule/synesth/data-pipeline/output",  -- 用户特定路径
            os.getenv("HOME") .. "/Desktop/Sound_Capsule/synesth/data-pipeline/output",  -- 通用路径
            synesthOutputPath,  -- 环境变量或默认路径
            projectDir .. "/output"  -- REAPER项目目录/output (备用)
        }

        reaper.ShowConsoleMsg("尝试路径列表:\n")
        for idx, path in ipairs(possiblePaths) do
            reaper.ShowConsoleMsg(string.format("  %d. %s\n", idx, path))
        end

        for idx, path in ipairs(possiblePaths) do
            if path ~= nil then
                -- 尝试创建目录（跨平台）
                MakeDir(path)
                -- 检查是否成功
                local testFile = JoinPath(path, ".test")
                local f = io.open(testFile, "w")
                if f ~= nil then
                    f:close()
                    os.remove(testFile)
                    outputBaseDir = path
                    reaper.ShowConsoleMsg(string.format("✓ 备用路径 %d 可用: %s\n", idx, outputBaseDir))
                    break
                else
                    reaper.ShowConsoleMsg(string.format("✗ 备用路径 %d 不可写: %s\n", idx, path))
                end
            end
        end

        -- 如果所有路径都失败，使用默认路径
        if outputBaseDir == nil or outputBaseDir == "" then
            outputBaseDir = synesthOutputPath
            reaper.ShowConsoleMsg("⚠️  所有备用路径失败，使用默认路径: " .. outputBaseDir .. "\n")
        end
    end

    reaper.ShowConsoleMsg("==================\n")

    -- 保存当前工程路径（用于后续恢复）
    local originalProjectPath = currentProjectPath

    -- 在循环开始前，保存所有Item的位置信息（避免打开新工程后对象失效）
    local itemInfoList = {}
    for idx, item in ipairs(selectedItems) do
        local itemTrack = reaper.GetMediaItemTrack(item)
        if itemTrack == nil then
            reaper.ShowConsoleMsg("警告：Item " .. idx .. " 无效，跳过\n")
        else
            local itemInfo = {
                itemStart = reaper.GetMediaItemInfo_Value(item, "D_POSITION"),
                itemLength = reaper.GetMediaItemInfo_Value(item, "D_LENGTH"),
                trackNumber = reaper.GetMediaTrackInfo_Value(itemTrack, "IP_TRACKNUMBER"),
                itemName = GetItemName(item),
                trackName = reaper.GetSetMediaTrackInfo_String(itemTrack, "P_NAME", "", false)
            }
            table.insert(itemInfoList, itemInfo)
        end
    end

    if #itemInfoList == 0 then
        -- 自动导出模式下不弹窗，只记录日志
        if not _SYNEST_AUTO_EXPORT then
            reaper.ShowMessageBox("没有有效的Item可以导出", "错误", 0)
        else
            reaper.ShowConsoleMsg("[自动导出] 错误: 没有有效的Item可以导出\n")
        end
        return false
    end

    -- 使用用户输入的名称（已经在对话框处理时设置）
    -- capsuleName 已经在对话框函数中设置好了

    local outputDir = JoinPath(outputBaseDir, capsuleName)
    reaper.ShowConsoleMsg("创建输出目录: " .. outputDir .. "\n")
    MakeDir(outputDir)

    -- ============================================================
    -- 新版导出流程：不切换工程
    -- ============================================================
    
    reaper.ShowConsoleMsg("\n========== 新版导出流程 (不切换工程) ==========\n")
    
    -- 获取胶囊类型
    local capsuleType = "magic"
    if _SYNEST_AUTO_EXPORT and _SYNEST_AUTO_EXPORT.capsule_type then
        capsuleType = _SYNEST_AUTO_EXPORT.capsule_type
    end
    
    -- 步骤 1：收集选中 items 的媒体文件
    local mediaFiles, collectedItemsInfo = CollectSelectedItemsMedia()
    local hasMidiItems = HasMidiItems(collectedItemsInfo)
    
    local mediaCount = 0
    for _ in pairs(mediaFiles) do mediaCount = mediaCount + 1 end
    
    local hasItems = collectedItemsInfo and #collectedItemsInfo > 0
    if mediaCount == 0 and not hasItems then
        reaper.ShowConsoleMsg("⚠ 警告：没有找到媒体文件（选中的 Item 可能无有效媒体源）\n")
    elseif mediaCount == 0 and hasItems then
        reaper.ShowConsoleMsg("检测到纯 MIDI 导出，跳过媒体文件复制步骤\n")
    end
    
    -- 步骤 2：复制媒体文件到 Audio 目录
    BridgePhase("saving capsule: copying media")
    local audioDir = JoinPath(outputDir, "Audio")
    local pathMapping, failedFiles = CopyMediaFiles(mediaFiles, audioDir)
    
    -- 步骤 3：生成新的 RPP 文件（不切换工程）
    BridgePhase("saving capsule: generating rpp")
    -- 传递选中 items 的时间范围用于渲染
    local rppPath = GenerateCapsuleRPP(outputDir, capsuleName, pathMapping, exportPreview, startTime, endTime, hasMidiItems)
    
    if not rppPath then
        reaper.ShowConsoleMsg("✗ RPP 生成失败\n")
        return false
    end

    RewriteRppRenderOutputToCurrentDir(rppPath, capsuleName)
    
    -- 步骤 4：生成 metadata.json
    BridgePhase("saving capsule: writing metadata")
    GenerateCapsuleMetadata(outputDir, capsuleName, capsuleType, collectedItemsInfo, mediaFiles, failedFiles)
    BridgePhase("saving capsule: done")
    
    -- 步骤 5：渲染预览音频（使用 -renderproject 命令）
    if exportPreview then
        BridgePhase("rendering preview: starting")
        reaper.ShowConsoleMsg("\n=== 渲染预览音频 ===\n")

        local reaperPath = nil
        if IsWindows() then
            if reaper.GetExePath then
                local exePath = reaper.GetExePath()
                if exePath and exePath ~= "" then
                    local candidates = {
                        exePath,
                        JoinPath(exePath, "reaper.exe"),
                    }
                    for _, path in ipairs(candidates) do
                        local f = io.open(path, "r")
                        if f then
                            f:close()
                            reaperPath = path
                            break
                        end
                    end
                end
            end

            if not reaperPath then
                local possiblePaths = {
                    "C:\\My Audio Tools\\REAPER\\reaper.exe",
                    "C:\\Program Files\\REAPER (x64)\\reaper.exe",
                    "C:\\Program Files\\REAPER (arm64)\\reaper.exe",
                    "C:\\Program Files\\REAPER\\reaper.exe",
                    "C:\\Program Files (x86)\\REAPER\\reaper.exe",
                }
                for _, path in ipairs(possiblePaths) do
                    local f = io.open(path, "r")
                    if f then
                        f:close()
                        reaperPath = path
                        break
                    end
                end
            end
        end

        if reaperPath then
            -- Render through a Windows helper that launches a separate minimized
            -- REAPER process and restores the user's foreground window, matching
            -- the macOS focus-safe render helper behavior.
            local rewriteOk = RewriteRppRenderOutputToCurrentDir(rppPath, capsuleName)
            local renderResult = RunWindowsBackgroundRender(reaperPath, rppPath, outputDir, 190000)
            reaper.SetExtState("capsule_transfer", "preview_render_debug", "reaper=" .. tostring(reaperPath) .. "; rpp=" .. tostring(rppPath) .. "; output_dir=" .. tostring(outputDir) .. "; rewrite_ok=" .. tostring(rewriteOk) .. "; result=" .. tostring(renderResult), false)
            reaper.ShowConsoleMsg("✓ 渲染命令已完成，返回: " .. tostring(renderResult) .. "\n")
            BridgePhase("rendering preview: finished")
        else
            reaper.ShowConsoleMsg("⚠ 未找到 REAPER，请手动渲染\n")
            BridgePhase("rendering preview: skipped no reaper")
        end
    end
    
    -- 完成
    reaper.ShowConsoleMsg("\n========== 导出完成 ==========\n")
    reaper.ShowConsoleMsg("胶囊目录: " .. outputDir .. "\n")
    reaper.ShowConsoleMsg("RPP 文件: " .. rppPath .. "\n")
    reaper.ShowConsoleMsg("原工程: 未修改\n")
    reaper.ShowConsoleMsg("================================\n")
    
    -- 如果是自动导出模式，不显示弹窗
    if not _SYNEST_AUTO_EXPORT then
        reaper.ShowMessageBox("胶囊导出完成！\n\n目录: " .. outputDir .. "\n\n原工程未修改。", "完成", 0)
    end

    return true
end

-- 主函数
function main()
    return ExportCapsule()
end

-- Windows 版本：不自动调用 main()
-- 由入口脚本 auto_export_from_config_windows.lua 显式调用
-- 如果需要直接测试，在 REAPER 中手动调用 main()
