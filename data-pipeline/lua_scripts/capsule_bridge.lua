-- Capsule Transfer persistent REAPER bridge
-- Runs inside REAPER and polls ExtState commands without bringing REAPER to foreground.
-- Install once, then keep REAPER open/minimized while Capsule Transfer sends commands.

local SECTION = "capsule_transfer"
local BRIDGE_VERSION = "1.0.6"
local HEARTBEAT_STALE_SECONDS = 15
local COMMAND_KEY = "command_v2"
local RESULT_KEY = "result_v2"
local HEARTBEAT_KEY = "heartbeat_v2"
local VERSION_KEY = "bridge_version_v2"
local RUNNING_KEY = "_CAPSULE_TRANSFER_BRIDGE_V2_RUNNING"
local INSTANCE_KEY = "bridge_instance_id"
local CONFLICT_KEY = "bridge_instance_conflict"
local PROCESS_DISABLE_ENV = "CAPSULE_TRANSFER_BRIDGE_DISABLED"
local NO_SELECTION_GRACE_SECONDS = 8
local seed = reaper.time_precise and math.floor(reaper.time_precise() * 1000000) or os.time()
math.randomseed(seed)
local INSTANCE_ID = tostring(seed) .. "-" .. tostring(math.random(100000, 999999))

local logger = nil
pcall(function()
  local dir = debug.getinfo(1).source:match("@(.*[/\\])") or ""
  logger = dofile(dir .. "diagnostic_logger.lua")
end)

local function Diag(event, fields)
  if logger and logger.write then
    pcall(logger.write, event, fields or {})
  end
end

Diag("bridge_boot", {
  version = BRIDGE_VERSION,
  instance_id = INSTANCE_ID,
  exe_path = reaper.GetExePath and tostring(reaper.GetExePath()) or "",
  app_version = reaper.GetAppVersion and tostring(reaper.GetAppVersion()) or "",
})

if os.getenv(PROCESS_DISABLE_ENV) == "1" then
  Diag("bridge_disabled_env", { env = PROCESS_DISABLE_ENV })
  return
end

if _G[RUNNING_KEY] then
  local last_heartbeat = tonumber(reaper.GetExtState(SECTION, HEARTBEAT_KEY) or "")
  local status = reaper.GetExtState(SECTION, "status")
  local age = last_heartbeat and (os.time() - last_heartbeat) or nil
  local existing_instance = tostring(_G[RUNNING_KEY])
  reaper.SetExtState(SECTION, CONFLICT_KEY, "existing=" .. existing_instance .. "; rejected=" .. INSTANCE_ID, false)
  Diag("bridge_already_running", {
    existing_instance_id = existing_instance,
    rejected_instance_id = INSTANCE_ID,
    status = status,
    heartbeat_age = age or "",
  })
  if status == "exporting" or (age and age >= 0 and age <= HEARTBEAT_STALE_SECONDS) then
    return
  end
end
_G[RUNNING_KEY] = INSTANCE_ID
_CAPSULE_TRANSFER_BRIDGE_RUNNING = true
reaper.SetExtState(SECTION, INSTANCE_KEY, INSTANCE_ID, false)
reaper.SetExtState(SECTION, CONFLICT_KEY, "", false)

local function Heartbeat()
  local now = tostring(os.time())
  reaper.SetExtState(SECTION, HEARTBEAT_KEY, now, false)
  reaper.SetExtState(SECTION, "heartbeat", now, false)
  reaper.SetExtState(SECTION, INSTANCE_KEY, INSTANCE_ID, false)
  reaper.SetExtState(SECTION, CONFLICT_KEY, "", false)

  local exe_path = ""
  if reaper.GetExePath then
    local ok, result = pcall(reaper.GetExePath)
    if ok and result then exe_path = tostring(result) end
  end
  reaper.SetExtState(SECTION, "bridge_exe_path", exe_path, false)

  local app_version = ""
  if reaper.GetAppVersion then
    local ok, result = pcall(reaper.GetAppVersion)
    if ok and result then app_version = tostring(result) end
  end
  reaper.SetExtState(SECTION, "bridge_app_version", app_version, false)

  local resource_path = ""
  if reaper.GetResourcePath then
    local ok, result = pcall(reaper.GetResourcePath)
    if ok and result then resource_path = tostring(result) end
  end
  reaper.SetExtState(SECTION, "bridge_resource_path", resource_path, false)

  local project_path = ""
  if reaper.EnumProjects then
    local ok, _, result = pcall(reaper.EnumProjects, -1, "")
    if ok and result then project_path = tostring(result) end
  end
  reaper.SetExtState(SECTION, "bridge_project_path", project_path, false)
  reaper.SetExtState(SECTION, "selected_item_count", tostring(reaper.CountSelectedMediaItems(0)), false)
end

local function Phase(msg)
  Heartbeat()
  reaper.SetExtState(SECTION, "export_phase", tostring(msg or ""), false)
  Diag("bridge_phase", {
    phase = tostring(msg or ""),
    instance_id = INSTANCE_ID,
    selected_items = reaper.CountSelectedMediaItems(0),
  })
end

local ENABLE_CONSOLE = false
local function Log(msg)
  if ENABLE_CONSOLE then reaper.ShowConsoleMsg("[CapsuleBridge] " .. tostring(msg) .. "\n") end
end

local function EscapeJsonString(s)
  s = tostring(s or "")
  s = s:gsub("\\", "\\\\")
  s = s:gsub('"', '\\"')
  s = s:gsub("\n", "\\n")
  s = s:gsub("\r", "\\r")
  s = s:gsub("\t", "\\t")
  return s
end

local function WriteJsonResult(success, request_id, capsule_name, error_msg, extra)
  local parts = {}
  table.insert(parts, '{')
  table.insert(parts, '"success": ' .. (success and 'true' or 'false'))
  table.insert(parts, ', "request_id": "' .. EscapeJsonString(request_id or "") .. '"')
  table.insert(parts, ', "bridge_version": "' .. EscapeJsonString(BRIDGE_VERSION) .. '"')
  if capsule_name then table.insert(parts, ', "capsule_name": "' .. EscapeJsonString(capsule_name) .. '"') end
  if error_msg then table.insert(parts, ', "error": "' .. EscapeJsonString(error_msg) .. '"') end
  if extra then
    for k, v in pairs(extra) do
      if type(v) == "boolean" then
        table.insert(parts, ', "' .. EscapeJsonString(k) .. '": ' .. (v and 'true' or 'false'))
      elseif type(v) == "number" then
        table.insert(parts, ', "' .. EscapeJsonString(k) .. '": ' .. tostring(v))
      else
        table.insert(parts, ', "' .. EscapeJsonString(k) .. '": "' .. EscapeJsonString(v) .. '"')
      end
    end
  end
  table.insert(parts, '}')
  local payload = table.concat(parts)
  reaper.SetExtState(SECTION, RESULT_KEY, payload, false)
  reaper.SetExtState(SECTION, "result", payload, false)
  reaper.SetExtState(SECTION, "last_result_debug", payload, false)
  Diag("bridge_result_written", {
    request_id = request_id or "",
    success = tostring(success),
    capsule_name = capsule_name or "",
    error = error_msg or "",
  })
end

local function ExtractJsonString(json, key)
  if not json or not key then return nil end
  local pattern = '"' .. key .. '"%s*:%s*"(.-)"'
  local raw = json:match(pattern)
  if not raw then return nil end
  raw = raw:gsub('\\"', '"')
  raw = raw:gsub('\\\\', '\\')
  raw = raw:gsub('\\n', '\n')
  raw = raw:gsub('\\r', '\r')
  raw = raw:gsub('\\t', '\t')
  return raw
end

local function ExtractJsonBoolean(json, key, default_value)
  if not json or not key then return default_value end
  local raw = json:match('"' .. key .. '"%s*:%s*(true)')
  if raw == "true" then return true end
  raw = json:match('"' .. key .. '"%s*:%s*(false)')
  if raw == "false" then return false end
  return default_value
end

local function ExtractCommand(json)
  return {
    type = ExtractJsonString(json, "type") or "",
    request_id = ExtractJsonString(json, "request_id") or "",
    project_name = ExtractJsonString(json, "project_name") or "magic",
    theme_name = ExtractJsonString(json, "theme_name") or "magic",
    capsule_type = ExtractJsonString(json, "capsule_type") or "magic",
    username = ExtractJsonString(json, "username") or "user",
    export_dir = ExtractJsonString(json, "export_dir"),
    main_export_lua = ExtractJsonString(json, "main_export_lua"),
    main_export_windows_lua = ExtractJsonString(json, "main_export_windows_lua"),
    render_preview = ExtractJsonBoolean(json, "render_preview", true),
  }
end

local function IsWindows()
  return package.config:sub(1,1) == "\\"
end

local function JoinPath(base, name)
  base = tostring(base or ""):gsub("[/\\]+$", "")
  if base == "" then return tostring(name or "") end
  return base .. "/" .. tostring(name or "")
end

local function FileExists(path)
  local f = io.open(path, "r")
  if f then
    f:close()
    return true
  end
  return false
end

local function SleepSeconds(seconds)
  seconds = tonumber(seconds) or 1
  local started = reaper.time_precise and reaper.time_precise() or os.clock()
  while true do
    local now = reaper.time_precise and reaper.time_precise() or os.clock()
    if now - started >= seconds then
      return
    end
  end
end

local function IsPreviewAudioFile(name)
  local lower = tostring(name or ""):lower()
  return lower:match("%.ogg$") or lower:match("%.wav$") or lower:match("%.mp3$") or lower:match("%.flac$")
end

local function ListDirectoryFiles(dir)
  local files = {}
  if reaper.EnumerateFiles then
    local i = 0
    while i < 500 do
      local name = reaper.EnumerateFiles(dir, i)
      if not name then break end
      table.insert(files, name)
      i = i + 1
    end
  end
  return files
end

local function JoinFilesForDebug(files)
  if not files or #files == 0 then return "" end
  local parts = {}
  for i, name in ipairs(files) do
    if i > 30 then
      table.insert(parts, "...")
      break
    end
    table.insert(parts, tostring(name))
  end
  return table.concat(parts, ", ")
end

local function FindPreviewAudio(capsule_dir, capsule_name)
  local candidates = {
    capsule_name .. ".ogg",
    capsule_name .. ".wav",
    capsule_name .. ".mp3",
    capsule_name .. ".flac",
  }
  for _, name in ipairs(candidates) do
    if FileExists(JoinPath(capsule_dir, name)) then
      return name
    end
  end

  local files = ListDirectoryFiles(capsule_dir)
  local prefix = tostring(capsule_name or ""):lower()
  local fallback = ""
  for _, name in ipairs(files) do
    if IsPreviewAudioFile(name) then
      local lower = tostring(name):lower()
      if lower == (prefix .. ".ogg") or lower == (prefix .. ".wav") then
        return name
      end
      if lower:sub(1, #prefix) == prefix then
        return name
      end
      if fallback == "" then
        fallback = name
      end
    end
  end
  return fallback
end

local function WaitForPreviewAudio(capsule_dir, capsule_name, timeout_seconds)
  local deadline = os.time() + (timeout_seconds or 12)
  local found = ""
  while os.time() <= deadline do
    found = FindPreviewAudio(capsule_dir, capsule_name)
    if found and found ~= "" then
      return found
    end
    SleepSeconds(1)
  end
  return ""
end

local function ScriptDir()
  local src = debug.getinfo(1).source or ""
  local path = src:match("@(.*)$") or src
  return path:match("(.*[/\\])") or ""
end

local function SelectMainExportScript(cmd)
  if IsWindows() then
    if cmd.main_export_windows_lua and cmd.main_export_windows_lua ~= "" then return cmd.main_export_windows_lua end
    return ScriptDir() .. "main_export2_windows.lua"
  end
  if cmd.main_export_lua and cmd.main_export_lua ~= "" then return cmd.main_export_lua end
  return ScriptDir() .. "main_export2.lua"
end

local function RunExport(cmd)
  Phase("checking selected items")
  local selected = reaper.CountSelectedMediaItems(0)
  if selected == 0 then
    return false, nil, "没有选中的 Items。请在 REAPER 中选中要导出的音频 Items 后再捕获。", false
  end

  local timestamp = os.date("%Y%m%d_%H%M%S")
  local capsule_name = (cmd.capsule_type or "magic") .. "_" .. (cmd.username or "user") .. "_" .. timestamp
  local requested_preview = cmd.render_preview == true

  _SYNEST_AUTO_EXPORT = {
    project_name = cmd.project_name or cmd.capsule_type or "magic",
    theme_name = cmd.theme_name or cmd.capsule_type or "magic",
    render_preview = requested_preview,
    capsule_type = cmd.capsule_type or "magic",
    capsule_name = capsule_name,
    export_dir = cmd.export_dir,
  }

  local main_script = SelectMainExportScript(cmd)
  Phase("loading main export script: " .. tostring(main_script))
  local main_export_func, load_err = loadfile(main_script)
  if not main_export_func then
    _SYNEST_AUTO_EXPORT = nil
    return false, nil, "无法加载主导出脚本: " .. tostring(load_err or main_script), requested_preview
  end

  Phase("initializing main export script")
  local load_ok, load_result = pcall(main_export_func)
  if not load_ok then
    _SYNEST_AUTO_EXPORT = nil
    return false, nil, "加载主导出脚本失败: " .. tostring(load_result), requested_preview
  end

  if type(main) ~= "function" then
    _SYNEST_AUTO_EXPORT = nil
    return false, nil, "主导出脚本未定义 main() 函数", requested_preview
  end

  Phase("running main_export2 main()")
  local ok, r1, r2 = pcall(main)
  local final_capsule_name = _SYNEST_AUTO_EXPORT and _SYNEST_AUTO_EXPORT.capsule_name or capsule_name
  _SYNEST_AUTO_EXPORT = nil

  if not ok then
    return false, nil, "导出异常: " .. tostring(r1), requested_preview
  end
  if r1 == true then
    Phase("main_export2 returned success")
    local preview_rendered = false
    local preview_audio = ""
    local preview_debug = ""
    if requested_preview and cmd.export_dir and final_capsule_name then
      Phase("checking preview output")
      local capsule_dir = JoinPath(cmd.export_dir, final_capsule_name)
      preview_audio = WaitForPreviewAudio(capsule_dir, final_capsule_name, 12)
      if preview_audio and preview_audio ~= "" then
        preview_rendered = true
      end
      preview_debug = "dir=" .. capsule_dir .. "; files=" .. JoinFilesForDebug(ListDirectoryFiles(capsule_dir))
    end
    reaper.SetExtState(SECTION, "preview_search_debug", preview_debug, false)
    return true, final_capsule_name, nil, requested_preview, preview_rendered, preview_audio
  end

  local err = (type(r2) == "string" and r2 ~= "") and r2 or "导出失败：请确认 REAPER 中已选中至少一个 Audio Item"
  return false, nil, err, requested_preview
end

local function HandleCommand(raw)
  local cmd = ExtractCommand(raw)
  if cmd.type == "ping" then
    WriteJsonResult(true, cmd.request_id, nil, nil, { status = "ready", type = "pong" })
    return
  end

  if cmd.type ~= "export_capsule" then
    WriteJsonResult(false, cmd.request_id, nil, "未知 bridge 命令: " .. tostring(cmd.type))
    return
  end

  reaper.SetExtState(SECTION, "status", "exporting", false)
  Phase("bridge received export command")
  local ok, capsule_name, err, preview_requested, preview_rendered, preview_audio = RunExport(cmd)
  reaper.SetExtState(SECTION, "status", "idle", false)
  if ok then
    Phase("writing bridge success result")
    local preview_debug = reaper.GetExtState(SECTION, "preview_search_debug") or ""
    local render_debug = reaper.GetExtState(SECTION, "preview_render_debug") or ""
    WriteJsonResult(true, cmd.request_id, capsule_name, nil, {
      mode = "bridge",
      preview_requested = preview_requested == true,
      preview_rendered = preview_rendered == true,
      preview_audio = preview_audio or "",
      preview_note = preview_requested and ((preview_rendered == true) and "preview rendered" or "preview requested but output file was not found") or "preview disabled",
      preview_debug = preview_debug,
      render_debug = render_debug,
    })
    Phase("idle")
  else
    Phase("writing bridge error result")
    WriteJsonResult(false, cmd.request_id, nil, err, { mode = "bridge" })
    Phase("idle")
  end
end

local function PollOnce()
  if _G[RUNNING_KEY] ~= INSTANCE_ID then
    reaper.SetExtState(SECTION, CONFLICT_KEY, "active=" .. tostring(_G[RUNNING_KEY]) .. "; stopped=" .. INSTANCE_ID, false)
    Diag("bridge_instance_stopped", {
      active_instance_id = tostring(_G[RUNNING_KEY]),
      stopped_instance_id = INSTANCE_ID,
    })
    return false
  end

  reaper.SetExtState(SECTION, VERSION_KEY, BRIDGE_VERSION, false)
  reaper.SetExtState(SECTION, "bridge_version", BRIDGE_VERSION, false)
  Heartbeat()

  local raw = reaper.GetExtState(SECTION, COMMAND_KEY)
  if raw and raw ~= "" then
    local command_type = ExtractJsonString(raw, "type") or ""
    local request_id = ExtractJsonString(raw, "request_id") or ""

    Diag("command_detected", {
      request_id = request_id,
      instance_id = INSTANCE_ID,
      command_type = command_type,
      selected_items = reaper.CountSelectedMediaItems(0),
    })

    if command_type == "export_capsule" and reaper.CountSelectedMediaItems(0) == 0 then
      local now = reaper.time_precise and reaper.time_precise() or os.time()
      if _G._CAPSULE_TRANSFER_NO_SELECTION_REQUEST_ID ~= request_id then
        _G._CAPSULE_TRANSFER_NO_SELECTION_REQUEST_ID = request_id
        _G._CAPSULE_TRANSFER_NO_SELECTION_FIRST_SEEN = now
        Diag("no_selection_first_seen", {
          request_id = request_id,
        })
      end
      local first_seen = _G._CAPSULE_TRANSFER_NO_SELECTION_FIRST_SEEN or now
      if (now - first_seen) < NO_SELECTION_GRACE_SECONDS then
        Phase("export command skipped by instance with no selected items")
        return
      end
    end

    reaper.SetExtState(SECTION, COMMAND_KEY, "", false)
    reaper.SetExtState(SECTION, "command_owner_instance_id", INSTANCE_ID, false)
    reaper.SetExtState(SECTION, "command_owner_request_id", request_id, false)
    Diag("command_cleared", {
      request_id = request_id,
      instance_id = INSTANCE_ID,
    })

    _G._CAPSULE_TRANSFER_NO_SELECTION_REQUEST_ID = nil
    _G._CAPSULE_TRANSFER_NO_SELECTION_FIRST_SEEN = nil
    local ok, err = pcall(HandleCommand, raw)
    if not ok then
      local request_id = ExtractJsonString(raw, "request_id") or ""
      reaper.SetExtState(SECTION, "status", "idle", false)
      Phase("bridge pcall error")
      Diag("bridge_pcall_error", {
        request_id = request_id,
        error = tostring(err),
      })
      WriteJsonResult(false, request_id, nil, "bridge 执行失败: " .. tostring(err), { mode = "bridge" })
    end
  end

  return true
end

local function Poll()
  local ok, keep_going = pcall(PollOnce)
  if not ok then
    reaper.SetExtState(SECTION, "status", "idle", false)
    Phase("bridge poll error")
    Diag("poll_error", {
      error = tostring(keep_going),
    })
    WriteJsonResult(false, "", nil, "bridge 轮询失败: " .. tostring(keep_going), { mode = "bridge" })
  end
  if ok and keep_going == false then return end
  reaper.defer(Poll)
end

reaper.SetExtState(SECTION, COMMAND_KEY, "", false)
reaper.SetExtState(SECTION, RESULT_KEY, "", false)
reaper.SetExtState(SECTION, "status", "idle", false)
Phase("idle")
Diag("bridge_ready", { version = BRIDGE_VERSION })
Poll()
