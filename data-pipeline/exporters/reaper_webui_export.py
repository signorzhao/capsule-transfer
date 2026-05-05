"""
REAPER Web UI 远程控制导出器

使用配置文件 + -nonewinst 参数在当前实例中执行脚本
"""

import os
import json
import time
import subprocess
import shutil
import tempfile
import platform
from pathlib import Path
from typing import Dict, Any, Optional


def run_lua_on_mac_safely(lua_script_path: str) -> tuple:
    """
    在 macOS 上让 REAPER 执行 Lua 脚本，**完全不切换窗口焦点**。

    使用 NSWorkspace.openURLs(activates=False)，这是 macOS 唯一能保证
    不激活目标 App 窗口的方式。通过系统 Python3（自带 pyobjc bridge）调用。
    返回 (success: bool, stderr_or_none: Optional[str])
    """
    abs_path = os.path.abspath(lua_script_path)

    # 用系统 /usr/bin/python3 调用 NSWorkspace（自带 AppKit bridge）
    py_code = f'''
import sys
try:
    from AppKit import NSWorkspace, NSWorkspaceOpenConfiguration, NSURL
    config = NSWorkspaceOpenConfiguration.alloc().init()
    config.setActivates_(False)
    ws = NSWorkspace.sharedWorkspace()
    file_url = NSURL.fileURLWithPath_("{abs_path}")
    app_url = NSURL.fileURLWithPath_("/Applications/REAPER.app")
    ws.openURLs_withApplicationAtURL_configuration_completionHandler_([file_url], app_url, config, None)
    import time; time.sleep(0.3)
except Exception as e:
    print("NSWorkspace failed: " + str(e), file=sys.stderr)
    sys.exit(1)
'''
    print(f"macOS: 通过 NSWorkspace(activates=False) 后台触发 Lua 脚本")
    try:
        result = subprocess.run(
            ["/usr/bin/python3", "-c", py_code],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            print("✓ NSWorkspace 触发成功（焦点不变）")
            return True, None
        # NSWorkspace 失败，回退 open -g（会短暂闪一下）
        print(f"⚠ NSWorkspace 失败: {result.stderr.strip()}，回退 open -g")
    except Exception as e:
        print(f"⚠ NSWorkspace 调用异常: {e}，回退 open -g")

    # 回退方案
    try:
        subprocess.run(["open", "-g", "-a", "REAPER", abs_path], check=True, timeout=10)
        print("✓ 回退 open -g 已发送")
        return True, None
    except Exception as e2:
        return False, str(e2)


def get_export_temp_dir() -> Path:
    """
    获取跨平台的临时导出目录
    
    Returns:
        临时目录路径
    """
    if platform.system() == "Windows":
        # Windows: 使用用户临时目录
        temp_base = Path(tempfile.gettempdir()) / "synest_export"
    else:
        # macOS/Linux: 使用 /tmp
        temp_base = Path("/tmp/synest_export")
    
    temp_base.mkdir(parents=True, exist_ok=True)
    return temp_base


def sanitize_path_for_lua(path: str) -> str:
    """
    将路径转换为 Lua 兼容格式

    Windows: C:\\Users\\xxx -> C:/Users/xxx
    Unix: /home/xxx -> /home/xxx

    Args:
        path: 原始路径

    Returns:
        Lua 兼容的路径字符串
    """
    if not path:
        return ""

    # 确保是绝对路径
    # 注意: pathlib 在非 Windows 系统上无法正确识别 Windows 路径
    # 所以我们需要手动检查 Windows 驱动器字母格式
    is_absolute = Path(path).is_absolute()

    # 如果不是绝对路径，检查是否是 Windows 风格的绝对路径
    if not is_absolute:
        # Windows 路径: C:\ 或 C:/
        if len(path) >= 2 and path[1] == ':':
            is_absolute = True

    if not is_absolute:
        raise ValueError(f"export_dir 必须是绝对路径: {path}")

    # 手动转换为正斜杠（跨平台兼容）
    # 在 Unix 系统上，pathlib 不会转换 Windows 风格的反斜杠
    lua_compatible_path = path.replace('\\', '/')

    return lua_compatible_path


class ReaperWebUIExporter:
    """REAPER Web UI 远程控制器"""

    def __init__(self, host: str = "localhost", port: int = 9000):
        """
        初始化 Web UI 客户端

        Args:
            host: REAPER Web UI 服务器地址
            port: REAPER Web UI 服务器端口
        """
        self.base_url = f"http://{host}:{port}"
        self.api_base = f"{self.base_url}/api"

    def test_connection(self) -> bool:
        """测试 Web UI 连接"""
        try:
            import requests
            response = requests.get(f"{self.base_url}", timeout=5)
            if response.status_code == 200:
                print(f"✓ REAPER Web UI 已连接: {self.base_url}")
                return True
            else:
                print(f"✗ Web UI 返回状态码: {response.status_code}")
                return False
        except ImportError:
            print(f"⚠ requests 模块未安装,跳过 Web UI 连接测试")
            return False
        except Exception as e:
            print(f"✗ 无法连接到 REAPER Web UI: {self.base_url}")
            print(f"  请确保 REAPER 中的 Web Server 已启动")
            print(f"  错误详情: {e}")
            return False

    def _find_reaper_executable(self) -> Optional[Path]:
        """
        查找 REAPER 可执行文件（跨平台）
        优先使用用户配置的路径
        
        Returns:
            REAPER 可执行文件路径，或 None
        """
        import platform
        system = platform.system()
        
        # 1. 优先读取用户配置
        try:
            if system == "Darwin":
                config_path = Path.home() / "Library/Application Support/com.soundcapsule.app/config.json"
            elif system == "Windows":
                config_path = Path.home() / "AppData/Roaming/com.soundcapsule.app/config.json"
            else:
                config_path = Path.home() / ".config/com.soundcapsule.app/config.json"
            
            if config_path.exists():
                with open(config_path, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                    reaper_path = config.get('reaper_path')
                    if reaper_path:
                        reaper_exe = Path(reaper_path)
                        if reaper_exe.exists():
                            print(f"✓ 使用用户配置的 REAPER 路径: {reaper_exe}")
                            return reaper_exe
                        else:
                            print(f"⚠️ 用户配置的 REAPER 路径不存在: {reaper_path}")
        except Exception as e:
            print(f"⚠️ 读取 REAPER 配置失败: {e}")
        
        # 2. 使用默认路径
        if system == "Darwin":
            paths = [
                Path("/Applications/REAPER.app/Contents/MacOS/REAPER"),
                Path("/Applications/REAPER64.app/Contents/MacOS/REAPER"),
                Path.home() / "Applications/REAPER.app/Contents/MacOS/REAPER"
            ]
        elif system == "Windows":
            paths = [
                Path("C:/Program Files/REAPER (x64)/reaper.exe"),
                Path("C:/Program Files/REAPER (arm64)/reaper.exe"),
                Path("C:/Program Files/REAPER/reaper.exe"),
                Path("C:/Program Files (x86)/REAPER/reaper.exe"),
                Path.home() / "AppData/Local/Programs/REAPER/reaper.exe"
            ]
        else:
            reaper_in_path = shutil.which("reaper")
            if reaper_in_path:
                return Path(reaper_in_path)
            paths = [Path("/usr/bin/reaper")]
        
        for path in paths:
            if path.exists():
                print(f"✓ 找到 REAPER: {path}")
                return path
        
        return None

    def prepare_export_config(self, config: Dict[str, Any]) -> bool:
        """
        准备导出配置文件

        Args:
            config: 配置字典，必须包含 export_dir 字段

        Returns:
            是否成功
        """
        temp_dir = get_export_temp_dir()

        config_file = temp_dir / "webui_export_config.json"

        try:
            # 验证并转换 export_dir 为绝对路径
            export_dir = config.get('export_dir')

            if export_dir:
                # 转换为 Lua 兼容的绝对路径
                sanitized_dir = sanitize_path_for_lua(export_dir)
                config['export_dir'] = sanitized_dir

                print(f"✓ 导出目录已验证:")
                print(f"  原始路径: {export_dir}")
                print(f"  转换后: {sanitized_dir}")

            with open(config_file, 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=2, ensure_ascii=False)

            print(f"✓ 配置已准备: {config_file}")
            return True
        except ValueError as e:
            print(f"✗ 路径验证失败: {e}")
            return False
        except Exception as e:
            print(f"✗ 写入配置失败: {e}")
            return False

    def export_via_webui(
        self,
        project_name: str,
        theme_name: str,
        render_preview: bool = True,
        capsule_type: str = 'magic',
        export_dir: str = None,
        username: str = None
    ) -> Dict[str, Any]:
        """
        通过 REAPER Web UI 执行导出

        流程:
        1. 测试连接
        2. 准备配置文件
        3. 等待用户在 REAPER 中手动执行导出
        4. 读取结果文件

        Args:
            project_name: 项目名
            theme_name: 主题名
            render_preview: 是否渲染预览
            capsule_type: 胶囊类型 (magic/impact/atmosphere)

        Returns:
            导出结果
        """
        # 注意: 我们使用 AppleScript 和 -nonewinst 参数,不需要 REAPER Web UI 运行
        # 但保留 test_connection() 作为可选的诊断信息

        print(f"尝试连接 REAPER Web UI (可选)...")
        connection_ok = self.test_connection()
        if not connection_ok:
            print(f"⚠ REAPER Web UI 未运行,但这不影响导出功能")
            print(f"  导出将通过 AppleScript/-nonewinst 直接执行")

        # 获取用户名：优先使用传入的用户名；不再回退系统用户名（避免机器名污染胶囊命名）
        if not username:
            username = "user"
            print(f"⚠️ 未传入用户名，使用安全默认值: {username}")
        else:
            print(f"✓ 使用登录用户名: {username}")

        # 0. 清理旧的结果文件（避免读取到旧数据）
        result_file = get_export_temp_dir() / "export_result.json"
        if result_file.exists():
            print(f"⚠️  发现旧的结果文件，删除: {result_file}")
            result_file.unlink()
            time.sleep(0.1)  # 短暂等待确保删除完成

        # 1. 准备配置
        config = {
            "project_name": project_name,
            "theme_name": theme_name,
            "render_preview": render_preview,
            "capsule_type": capsule_type,
            "username": username,
            "export_dir": export_dir  # 添加导出目录到配置
        }

        if not self.prepare_export_config(config):
            return {
                'success': False,
                'error': '准备配置失败'
            }

        # 3. 调用 REAPER 执行导出脚本
        from common import PathManager
        import platform
        pm = PathManager.get_instance()
        
        # Windows 使用专用脚本
        if platform.system() == "Windows":
            script_path = pm.get_lua_script("auto_export_from_config_windows.lua")
        else:
            script_path = pm.get_lua_script("auto_export_from_config.lua")

        if not script_path.exists():
            return {
                'success': False,
                'error': f'Lua 脚本不存在: {script_path}'
            }

        print(f"✓ 准备执行 Lua 脚本: {script_path}")

        try:
            import platform
            system = platform.system()
            
            if system == "Windows":
                # Windows: 直接用 REAPER 命令行执行脚本
                print(f"✓ Windows 平台，使用命令行方式执行脚本...")
                
                # 查找 REAPER 可执行文件
                reaper_cmd = self._find_reaper_executable()
                if not reaper_cmd:
                    return {
                        'success': False,
                        'error': '找不到 REAPER 可执行文件，请在设置中配置 REAPER 路径'
                    }
                
                print(f"✓ REAPER 路径: {reaper_cmd}")
                
                # Windows 上使用 -nonewinst 在现有实例中执行脚本
                # 注意：脚本路径需要使用 Windows 格式
                script_path_win = str(script_path).replace('/', '\\')
                cmd = [str(reaper_cmd), "-nonewinst", script_path_win]
                
                print(f"✓ 执行命令: {' '.join(cmd)}")
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=10
                )
                
                print(f"✓ REAPER 命令已发送")
                print(f"  返回码: {result.returncode}")
                if result.stdout:
                    print(f"  标准输出: {result.stdout}")
                if result.stderr:
                    print(f"  标准错误: {result.stderr}")
                    
            else:
                # macOS: 使用系统 open -a REAPER script.lua（打开文件机制，无需 AppleScript）
                print(f"✓ macOS 平台，使用 open -a REAPER 执行脚本...")
                ok, err = run_lua_on_mac_safely(str(script_path))
                if ok:
                    print(f"✓ open 命令已发送")
                else:
                    print(f"✗ open 失败: {err}")

                # 如果 open 失败，回退到命令行方法（优先带工程路径：在指定工程中运行脚本）
                if not ok:
                    print(f"⚠️  open 失败，尝试命令行方法...")

                    # 查找 REAPER 可执行文件
                    import shutil
                    reaper_cmd = shutil.which("reaper")
                    if not reaper_cmd:
                        # 尝试 macOS 默认路径
                        reaper_cmd = "/Applications/REAPER.app/Contents/MacOS/REAPER"
                        if not Path(reaper_cmd).exists():
                            return {
                                'success': False,
                                'error': '找不到 REAPER 可执行文件'
                            }

                    print(f"✓ REAPER 路径: {reaper_cmd}")

                    # 优先使用缓存的工程路径：reaper -nonewinst project.rpp script.lua 可在该工程中运行脚本
                    project_path_file = get_export_temp_dir() / "current_project_path.txt"
                    cmd = [reaper_cmd, "-nonewinst", str(script_path)]
                    if project_path_file.exists():
                        try:
                            project_path = project_path_file.read_text().strip()
                            if project_path and Path(project_path).exists():
                                cmd = [reaper_cmd, "-nonewinst", project_path, str(script_path)]
                                print(f"✓ 使用缓存的工程路径: {project_path}")
                        except Exception:
                            pass
                    if len(cmd) == 3:
                        print(f"⚠️  无工程路径缓存，脚本将作为工程打开，可能无法获取选中 Item")

                    print(f"✓ 执行命令: {' '.join(cmd)}")

                    result = subprocess.run(
                        cmd,
                        capture_output=True,
                        text=True,
                        timeout=5  # 只等待5秒，-nonewinst会立即返回
                    )

                    print(f"✓ REAPER 命令已发送")
                    print(f"  返回码: {result.returncode}")
                    print(f"  标准输出: {result.stdout}")
                    if result.stderr:
                        print(f"  标准错误: {result.stderr}")

        except subprocess.TimeoutExpired:
            return {
                'success': False,
                'error': 'REAPER 执行超时 (5秒) - 但这可能正常，继续等待结果文件...'
            }
        except Exception as e:
            return {
                'success': False,
                'error': f'执行 REAPER 失败: {e}'
            }

        # 4. 等待结果文件
        result_file = get_export_temp_dir() / "export_result.json"
        timeout = 180  # 3分钟
        start_time = time.time()
        check_interval = 0.2  # 每0.2秒检查一次（优化：从0.5减少）
        
        # 记录期望的胶囊名称，用于验证结果
        expected_capsule_name = f"{capsule_type}_{username}_"

        print(f"等待导出完成... (最长等待 {timeout} 秒)")
        print(f"检查间隔: {check_interval} 秒")
        print(f"期望的胶囊名称前缀: {expected_capsule_name}")

        waited_time = 0
        last_file_size = -1
        while time.time() - start_time < timeout:
            if result_file.exists():
                # 检查文件大小是否稳定（确保写入完成）
                current_size = result_file.stat().st_size
                file_age = time.time() - result_file.stat().st_mtime

                # 如果文件大小变化，等待写入完成
                if current_size != last_file_size:
                    last_file_size = current_size
                    time.sleep(0.1)  # 优化：从0.2减少
                    continue

                print(f"✓ 检测到结果文件! (文件年龄: {file_age:.2f}秒, 大小: {current_size})")
                try:
                    # 等待一小段时间确保文件写入完成
                    time.sleep(0.1)  # 优化：从0.2减少

                    # 使用 UTF-8 编码读取（Lua 脚本写入的是 UTF-8）
                    with open(result_file, 'r', encoding='utf-8') as f:
                        result_data = json.load(f)

                    # 清理文件
                    result_file.unlink(missing_ok=True)

                    print(f"✓ 结果文件读取成功")
                    print(f"  成功: {result_data.get('success')}")

                    if result_data.get('success'):
                        capsule = result_data.get('capsule_name')
                        print(f"✓ 导出成功: {capsule}")
                        return result_data
                    else:
                        error = result_data.get('error', '导出失败')
                        print(f"✗ 导出失败: {error}")
                        return {
                            'success': False,
                            'error': error
                        }
                except Exception as e:
                    print(f"✗ 读取结果文件失败: {e}")
                    # 继续等待，可能是文件正在写入

            waited_time = time.time() - start_time
            if int(waited_time) % 10 == 0 and waited_time > 0:
                print(f"  等待中... 已等待 {int(waited_time)} 秒")

            time.sleep(check_interval)

        # 超时
        print(f"✗ 等待超时 ({timeout}秒)")
        print(f"  结果文件不存在: {result_file}")

        # 检查临时目录
        temp_dir = get_export_temp_dir()
        if temp_dir.exists():
            print(f"  临时目录内容:")
            for file in temp_dir.iterdir():
                print(f"    - {file.name}")

        return {
            'success': False,
            'error': f'等待超时 ({timeout}秒)。REAPER可能未执行脚本或执行失败'
        }


def quick_webui_export(
    project_name: str,
    theme_name: str,
    render_preview: bool = True,
    webui_port: int = 9000,
    capsule_type: str = 'magic',
    export_dir: str = None,
    username: str = None
) -> Dict[str, Any]:
    """
    快捷 Web UI 导出函数

    Args:
        project_name: 项目名
        theme_name: 主题名
        render_preview: 是否渲染预览
        webui_port: Web UI 端口
        capsule_type: 胶囊类型 (magic/impact/atmosphere)
        export_dir: 导出目录路径（可选）
        username: 用户名（可选，用于胶囊命名，未传时使用安全默认值）

    Returns:
        导出结果
    """
    exporter = ReaperWebUIExporter(port=webui_port)
    return exporter.export_via_webui(project_name, theme_name, render_preview, capsule_type, export_dir, username)


if __name__ == '__main__':
    import sys

    if len(sys.argv) < 3:
        print("用法: python reaper_webui_export.py <项目名> <主题名> [渲染预览:1/0] [WebUI端口]")
        sys.exit(1)

    project = sys.argv[1]
    theme = sys.argv[2]
    preview = len(sys.argv) > 2 and sys.argv[3] == '1'
    port = int(sys.argv[4]) if len(sys.argv) > 4 else 9000

    print(f"REAPER Web UI 远程导出:")
    print(f"  项目: {project}")
    print(f"  主题: {theme}")
    print(f"  预览: {preview}")
    print(f"  WebUI 端口: {port}\n")

    result = quick_webui_export(project, theme, preview, port)

    if result['success']:
        print(f"\n✅ 导出成功!")
        print(f"   胶囊: {result.get('capsule_name')}")
    else:
        print(f"\n❌ 导出失败: {result.get('error')}")
        sys.exit(1)
