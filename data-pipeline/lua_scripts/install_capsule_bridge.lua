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

local function StartupBlock(bridge_path)
  return
    "-- >>> Capsule Transfer Bridge >>>\n" ..
    "pcall(function() dofile(" .. string.format("%q", bridge_path) .. ") end)\n" ..
    "-- <<< Capsule Transfer Bridge <<<\n"
end

local function CopyFile(src_path, dst_path)
  local src = io.open(src_path, "rb")
  if not src then
    return false, "无法读取 bridge 源文件: " .. tostring(src_path)
  end
  local content = src:read("*a") or ""
  src:close()

  local dst = io.open(dst_path, "wb")
  if not dst then
    return false, "无法写入 bridge 安装文件: " .. tostring(dst_path)
  end
  dst:write(content)
  dst:close()
  return true, ""
end

local function StartBridge(bridge_path)
  local bridge_func, load_err = loadfile(bridge_path)
  if not bridge_func then
    return false, "无法加载 bridge: " .. tostring(load_err)
  end

  local ok, err = pcall(bridge_func)
  if not ok then
    return false, "启动 bridge 失败: " .. tostring(err)
  end
  return true, ""
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

  local install_dir = scripts_dir .. "/CapsuleTransfer"
  reaper.RecursiveCreateDirectory(install_dir, 0)
  local installed_bridge_path = install_dir .. "/capsule_bridge.lua"
  local copied, copy_err = CopyFile(bridge_path, installed_bridge_path)
  if not copied then
    WriteResult(false, copy_err)
    return
  end

  local startup_path = scripts_dir .. "/__startup.lua"
  local marker_begin = "-- >>> Capsule Transfer Bridge >>>"
  local marker_end = "-- <<< Capsule Transfer Bridge <<<"
  local block = StartupBlock(installed_bridge_path)

  local existing = ""
  local rf = io.open(startup_path, "r")
  if rf then
    existing = rf:read("*a") or ""
    rf:close()
  end

  local marker_start = existing:find(marker_begin, 1, true)
  local marker_stop = marker_start and existing:find(marker_end, marker_start, true) or nil
  if marker_start and marker_stop then
    local after_marker = marker_stop + #marker_end
    local next_newline = existing:find("\n", after_marker, true) or #existing
    existing = existing:sub(1, marker_start - 1) .. block .. existing:sub(next_newline + 1)
    local wf = io.open(startup_path, "w")
    if not wf then
      WriteResult(false, "无法更新 REAPER 启动脚本: " .. startup_path)
      return
    end
    wf:write(existing)
    wf:close()
  else
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

  local started, start_err = StartBridge(installed_bridge_path)
  if not started then
    WriteResult(false, start_err)
    return
  end

  WriteResult(true, "Capsule Transfer Bridge 已安装到 REAPER 启动项并启动")
end

reaper.defer(Main)
