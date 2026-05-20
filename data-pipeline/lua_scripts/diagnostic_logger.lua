local M = {}

local function normalize(path)
  return tostring(path or ""):gsub("\\", "/")
end

local function join(a, b)
  a = normalize(a):gsub("/+$", "")
  if a == "" then return tostring(b or "") end
  return a .. "/" .. tostring(b or "")
end

local function ensure_dir(path)
  if reaper and reaper.RecursiveCreateDirectory then
    reaper.RecursiveCreateDirectory(path, 0)
  end
end

function M.log_path()
  local resource = ""
  if reaper and reaper.GetResourcePath then
    local ok, result = pcall(reaper.GetResourcePath)
    if ok and result then
      resource = normalize(result)
    end
  end
  local dir = join(resource, "CapsuleTransferLogs")
  ensure_dir(dir)
  return join(dir, "bridge.log")
end

function M.write(event, fields)
  local path = M.log_path()
  local f = io.open(path, "a")
  if not f then return end

  local wall = os.date("!%Y-%m-%dT%H:%M:%SZ")
  local mono = reaper and reaper.time_precise and string.format("%.6f", reaper.time_precise()) or tostring(os.clock())

  local parts = {
    wall,
    "mono=" .. mono,
    "event=" .. tostring(event or "")
  }

  fields = fields or {}
  for k, v in pairs(fields) do
    local value = tostring(v or "")
    value = value:gsub("\n", "\\n")
    value = value:gsub("\r", "\\r")
    table.insert(parts, tostring(k) .. "=" .. value)
  end

  f:write(table.concat(parts, " | ") .. "\n")
  f:close()
end

return M
