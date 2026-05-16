-- Capsule Transfer persistent REAPER bridge
-- Runs inside REAPER and polls ExtState commands without bringing REAPER to foreground.
-- Install once, then keep REAPER open/minimized while Capsule Transfer sends commands.

local SECTION = "capsule_transfer"
local BRIDGE_VERSION = "1.0.4"
local HEARTBEAT_STALE_SECONDS = 15
local COMMAND_KEY = "command_v2"
local RESULT_KEY = "result_v2"
local HEARTBEAT_KEY = "heartbeat_v2"
local VERSION_KEY = "bridge_version_v2"
local RUNNING_KEY = "_CAPSULE_TRANSFER_BRIDGE_V2_RUNNING"

if _G[RUNNING_KEY] then
  local last_heartbeat = tonumber(reaper.GetExtState(SECTION, HEARTBEAT_KEY) or "")
  local status = reaper.GetExtState(SECTION, "status")
  local age = last_heartbeat and (os.time() - last_heartbeat) or nil
  if status == "exporting" or (age and age >= 0 and age <= HEARTBEAT_STALE_SECONDS) then
    return
  end
end
_G[RUNNING_KEY] = true
_CAPSULE_TRANSFER_BRIDGE_RUNNING = true

local function Heartbeat()
  local now = tostring(os.time())
  reaper.SetExtState(SECTION, HEARTBEAT_KEY, now, false)
  reaper.SetExtState(SECTION, "heartbeat", now, false)
end

local function Phase(msg)
  Heartbeat()
  reaper.SetExtState(SECTION, "export_phase", tostring(msg or ""), false)
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
    if requested_preview and cmd.export_dir and final_capsule_name then
      local capsule_dir = JoinPath(cmd.export_dir, final_capsule_name)
      local ogg_name = final_capsule_name .. ".ogg"
      local wav_name = final_capsule_name .. ".wav"
      if FileExists(JoinPath(capsule_dir, ogg_name)) then
        preview_rendered = true
        preview_audio = ogg_name
      elseif FileExists(JoinPath(capsule_dir, wav_name)) then
        preview_rendered = true
        preview_audio = wav_name
      end
    end
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
    WriteJsonResult(true, cmd.request_id, capsule_name, nil, {
      mode = "bridge",
      preview_requested = preview_requested == true,
      preview_rendered = preview_rendered == true,
      preview_audio = preview_audio or "",
      preview_note = preview_requested and ((preview_rendered == true) and "preview rendered" or "preview requested but output file was not found") or "preview disabled",
    })
    Phase("idle")
  else
    Phase("writing bridge error result")
    WriteJsonResult(false, cmd.request_id, nil, err, { mode = "bridge" })
    Phase("idle")
  end
end

local function PollOnce()
  reaper.SetExtState(SECTION, VERSION_KEY, BRIDGE_VERSION, false)
  reaper.SetExtState(SECTION, "bridge_version", BRIDGE_VERSION, false)
  Heartbeat()

  local raw = reaper.GetExtState(SECTION, COMMAND_KEY)
  if raw and raw ~= "" then
    reaper.SetExtState(SECTION, COMMAND_KEY, "", false)
    local ok, err = pcall(HandleCommand, raw)
    if not ok then
      local request_id = ExtractJsonString(raw, "request_id") or ""
      reaper.SetExtState(SECTION, "status", "idle", false)
      Phase("bridge pcall error")
      WriteJsonResult(false, request_id, nil, "bridge 执行失败: " .. tostring(err), { mode = "bridge" })
    end
  end

end

local function Poll()
  local ok, err = pcall(PollOnce)
  if not ok then
    reaper.SetExtState(SECTION, "status", "idle", false)
    Phase("bridge poll error")
    WriteJsonResult(false, "", nil, "bridge 轮询失败: " .. tostring(err), { mode = "bridge" })
  end
  reaper.defer(Poll)
end

reaper.SetExtState(SECTION, COMMAND_KEY, "", false)
reaper.SetExtState(SECTION, RESULT_KEY, "", false)
reaper.SetExtState(SECTION, "status", "idle", false)
Phase("idle")
Poll()
