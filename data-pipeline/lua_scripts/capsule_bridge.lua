-- Capsule Transfer persistent REAPER bridge
-- Runs inside REAPER and polls ExtState commands without bringing REAPER to foreground.
-- Install once, then keep REAPER open/minimized while Capsule Transfer sends commands.

local SECTION = "capsule_transfer"
local BRIDGE_VERSION = "1.0.1"

if _CAPSULE_TRANSFER_BRIDGE_RUNNING then
  return
end
_CAPSULE_TRANSFER_BRIDGE_RUNNING = true

local ENABLE_CONSOLE = false
local function Log(msg)
  if ENABLE_CONSOLE then
    reaper.ShowConsoleMsg("[CapsuleBridge] " .. tostring(msg) .. "\n")
  end
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
  reaper.SetExtState(SECTION, "result", table.concat(parts), false)
end

local function ExtractJsonString(json, key)
  if not json or not key then return nil end
  local pattern = '"' .. key .. '"%s*:%s*"(([^"\\]|\\.)*)"'
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
  local selected = reaper.CountSelectedMediaItems(0)
  if selected == 0 then
    return false, nil, "没有选中的 Items。请在 REAPER 中选中要导出的音频 Items 后再捕获。", false
  end

  local timestamp = os.date("%Y%m%d_%H%M%S")
  local capsule_name = (cmd.capsule_type or "magic") .. "_" .. (cmd.username or "user") .. "_" .. timestamp
  local requested_preview = cmd.render_preview == true

  -- In persistent bridge mode, REAPER may be minimized. main_export2.lua's current
  -- preview path opens a render project tab and can block on render actions. To
  -- keep the save-capsule path reliable and focus-safe, export the capsule first
  -- and skip preview rendering here. Preview can be added later as a separate
  -- async job after the non-destructive capsule export succeeds.
  _SYNEST_AUTO_EXPORT = {
    project_name = cmd.project_name or cmd.capsule_type or "magic",
    theme_name = cmd.theme_name or cmd.capsule_type or "magic",
    render_preview = false,
    capsule_type = cmd.capsule_type or "magic",
    capsule_name = capsule_name,
    export_dir = cmd.export_dir,
  }

  local main_script = SelectMainExportScript(cmd)
  Log("loading main export: " .. tostring(main_script))

  local main_export_func, load_err = loadfile(main_script)
  if not main_export_func then
    _SYNEST_AUTO_EXPORT = nil
    return false, nil, "无法加载主导出脚本: " .. tostring(load_err or main_script), requested_preview
  end

  local load_ok, load_result = pcall(main_export_func)
  if not load_ok then
    _SYNEST_AUTO_EXPORT = nil
    return false, nil, "加载主导出脚本失败: " .. tostring(load_result), requested_preview
  end

  if type(main) ~= "function" then
    _SYNEST_AUTO_EXPORT = nil
    return false, nil, "主导出脚本未定义 main() 函数", requested_preview
  end

  local ok, r1, r2 = pcall(main)
  local final_capsule_name = _SYNEST_AUTO_EXPORT and _SYNEST_AUTO_EXPORT.capsule_name or capsule_name
  _SYNEST_AUTO_EXPORT = nil

  if not ok then
    return false, nil, "导出异常: " .. tostring(r1), requested_preview
  end
  if r1 == true then
    return true, final_capsule_name, nil, requested_preview
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
  local ok, capsule_name, err, preview_requested = RunExport(cmd)
  reaper.SetExtState(SECTION, "status", "idle", false)
  if ok then
    WriteJsonResult(true, cmd.request_id, capsule_name, nil, {
      mode = "bridge",
      preview_requested = preview_requested == true,
      preview_rendered = false,
      preview_note = preview_requested and "Bridge mode skipped preview render to avoid blocking REAPER while minimized" or "preview disabled",
    })
  else
    WriteJsonResult(false, cmd.request_id, nil, err, { mode = "bridge" })
  end
end

local function Poll()
  reaper.SetExtState(SECTION, "bridge_version", BRIDGE_VERSION, false)
  reaper.SetExtState(SECTION, "heartbeat", tostring(os.time()), false)

  local raw = reaper.GetExtState(SECTION, "command")
  if raw and raw ~= "" then
    reaper.SetExtState(SECTION, "command", "", false)
    local ok, err = pcall(HandleCommand, raw)
    if not ok then
      local request_id = ExtractJsonString(raw, "request_id") or ""
      reaper.SetExtState(SECTION, "status", "idle", false)
      WriteJsonResult(false, request_id, nil, "bridge 执行失败: " .. tostring(err), { mode = "bridge" })
    end
  end

  reaper.defer(Poll)
end

reaper.SetExtState(SECTION, "status", "idle", false)
Poll()
