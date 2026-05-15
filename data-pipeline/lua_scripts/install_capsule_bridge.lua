-- Capsule Transfer bridge installer
-- Runs once inside REAPER. It registers capsule_bridge.lua in Scripts/__startup.lua
-- and starts the bridge immediately. No UI, no modal dialogs.

local SECTION = "capsule_transfer"

local function EscapeJsonString(s)
  s = tostring(s or "")
  s = s:gsub("\\", "\\\\")
  s = s:gsub('"', '\\"')
  s = s:gsub("\n", "\\n")
  s = s:gsub("\r", "\\r")
  return s
end

local function WriteResult(success, message)
  local payload = string.format(
    '{"success": %s, "message": "%s"}',
    success and "true" or "false",
    EscapeJsonString(message or "")
  )
  reaper.SetExtState(SECTION, "install_result", payload, false)
end

local function NormalizePath(path)
  return tostring(path or ""):gsub("\\", "/")
end

local function CurrentScriptDir()
  local src = debug.getinfo(1).source or ""
  local path = src:match("@(.*)$") or src
  return path:match("(.*[/\\])") or ""
end

local function Main()
  local bridge_path = reaper.GetExtState(SECTION, "install_bridge_source")
  if not bridge_path or bridge_path == "" then
    bridge_path = CurrentScriptDir() .. "capsule_bridge.lua"
  end
  bridge_path = NormalizePath(bridge_path)

  local f = io.open(bridge_path, "r")
  if not f then
    WriteResult(false, "找不到 capsule_bridge.lua: " .. bridge_path)
    return
  end
  f:close()

  local resource_path = NormalizePath(reaper.GetResourcePath())
  local scripts_dir = resource_path .. "/Scripts"
  reaper.RecursiveCreateDirectory(scripts_dir, 0)

  local startup_path = scripts_dir .. "/__startup.lua"
  local marker_begin = "-- >>> Capsule Transfer Bridge >>>"
  local marker_end = "-- <<< Capsule Transfer Bridge <<<"
  local block = marker_begin .. "\n" ..
    "pcall(function() dofile(" .. string.format("%q", bridge_path) .. ") end)\n" ..
    marker_end .. "\n"

  local existing = ""
  local rf = io.open(startup_path, "r")
  if rf then
    existing = rf:read("*a") or ""
    rf:close()
  end

  if not existing:find(marker_begin, 1, true) then
    local wf = io.open(startup_path, "a")
    if not wf then
      WriteResult(false, "无法写入 REAPER 启动脚本: " .. startup_path)
      return
    end
    if existing ~= "" and not existing:match("\n$") then
      wf:write("\n")
    end
    wf:write("\n" .. block)
    wf:close()
  end

  local bridge_func, load_err = loadfile(bridge_path)
  if not bridge_func then
    WriteResult(false, "无法加载 bridge: " .. tostring(load_err))
    return
  end

  local ok, err = pcall(bridge_func)
  if not ok then
    WriteResult(false, "启动 bridge 失败: " .. tostring(err))
    return
  end

  reaper.SetExtState(SECTION, "bridge_version", "1.0.0", false)
  WriteResult(true, "Capsule Transfer Bridge 已安装并启动")
end

reaper.defer(Main)
