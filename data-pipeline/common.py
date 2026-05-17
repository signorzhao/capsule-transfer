"""
Common utilities and configuration shared across modules

This module contains shared utilities to avoid circular imports.
"""

import os
import json
from pathlib import Path


class PathManager:
    """
    单例路径管理器 - 所有路径的唯一来源
    
    这个类确保所有路径都由 Tauri 通过命令行参数传入，
    严禁 Python 后端自行猜测路径。
    """
    _instance = None
    
    def __init__(self, config_dir: Path, export_dir: Path, resource_dir: Path):
        """
        私有构造函数，只能通过 initialize() 调用
        
        Args:
            config_dir: 配置目录（由 Tauri 传递）
            export_dir: 导出目录（由 Tauri 传递）
            resource_dir: 资源目录（由 Tauri 传递）
        """
        self.config_dir = config_dir
        self.resource_dir = resource_dir
        
        # -------------------------------------------------------
        # 🛠️ 修复点 1: 实现用户配置覆盖逻辑
        # -------------------------------------------------------
        # 默认使用 CLI 传入的 export_dir
        self.export_dir = export_dir
        
        forced_export = os.environ.get("CAPSULE_TRANSFER_EXPORT_DIR") or os.environ.get("SYNESTH_CAPSULE_OUTPUT")
        if forced_export:
            print(f"🔄 [PathManager] 使用运行时导出路径: {forced_export}")
            self.export_dir = Path(forced_export)
        else:
            # 尝试从 config.json 读取用户自定义路径
            # 🔴 优先从系统配置目录读取（生产环境），如果不存在则从 config_dir 读取（开发环境）
            import sys

            config_locations = []

            # Windows: %APPDATA%\com.soundcapsule.app\config.json
            if sys.platform == 'win32':
                appdata = os.environ.get('APPDATA', Path.home() / 'AppData' / 'Roaming')
                config_locations.append(Path(appdata) / "com.soundcapsule.app" / "config.json")

            # macOS: ~/Library/Application Support/com.soundcapsule.app/config.json
            config_locations.append(Path.home() / "Library/Application Support/com.soundcapsule.app/config.json")

            # 通用: config_dir/config.json
            config_locations.append(self.config_dir / "config.json")

            for config_file in config_locations:
                try:
                    if config_file.exists():
                        with open(config_file, 'r', encoding='utf-8') as f:
                            data = json.load(f)
                            user_export = data.get('export_dir')
                            if user_export:
                                print(f"🔄 [PathManager] 从配置加载用户导出路径: {user_export}")
                                print(f"   配置文件: {config_file}")
                                self.export_dir = Path(user_export)
                                break  # 找到配置就停止
                except Exception as e:
                    continue  # 尝试下一个位置
        
        if self.export_dir == export_dir:
            print(f"⚠️ [PathManager] 未找到用户配置，使用默认导出路径: {export_dir}")

        # -------------------------------------------------------
        # 🛠️ 修复点 2: 修正 Schema 文件路径
        # -------------------------------------------------------
        # 派生路径
        self.db_path = config_dir / "database" / "capsules.db"
        
        # 检测平台和打包模式
        import sys
        self.platform = sys.platform
        self.is_windows = self.platform == 'win32'
        
        # 检测是否是 Tauri 打包版本（通过检查 _up_ 目录结构）
        self.is_tauri_bundled = (resource_dir / ".." / ".." / ".." / "_up_").resolve().exists() if self.is_windows else False
        
        # 🔴 Schema 文件路径：优先使用 resource_dir/database，备选多个位置
        self.schema_path = resource_dir / "database" / "capsule_schema.sql"
        
        # 如果默认路径不存在，尝试其他可能的位置
        if not self.schema_path.exists():
            alt_schema_paths = [
                resource_dir / "database" / "capsule_schema.sql",
                resource_dir.parent / "database" / "capsule_schema.sql",
                resource_dir.parent.parent.parent / "resources" / "database" / "capsule_schema.sql",
            ]
            for alt_path in alt_schema_paths:
                if alt_path.exists():
                    self.schema_path = alt_path
                    print(f"📄 [PathManager] 使用备选 Schema 路径: {alt_path}")
                    break
        
        self.lua_scripts_dir = resource_dir / "lua_scripts"
        
        # 如果默认 Lua 脚本路径不存在，尝试其他位置
        if not self.lua_scripts_dir.exists():
            alt_lua_paths = [
                resource_dir / "lua_scripts",
                resource_dir.parent.parent.parent / "_up_" / "_up_" / "data-pipeline" / "lua_scripts",
            ]
            for alt_path in alt_lua_paths:
                if alt_path.exists():
                    self.lua_scripts_dir = alt_path
                    print(f"📄 [PathManager] 使用备选 Lua 脚本路径: {alt_path}")
                    break
        
        # 确保关键目录存在
        self.config_dir.mkdir(parents=True, exist_ok=True)
        (self.config_dir / "database").mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)
        
        # -------------------------------------------------------
        # 🛠️ 修复点 3: 自动初始化数据库
        # -------------------------------------------------------
        # 检查数据库是否存在且表结构完整
        if not self.db_path.exists():
            print(f"📦 首次启动：初始化数据库...")
            self._init_database()
        else:
            # 文件存在，检查表结构是否完整
            if not self._check_database_schema():
                print(f"📦 检测到数据库表结构不完整，重新初始化...")
                self._init_database()
    
    @classmethod
    def initialize(cls, config_dir: str, export_dir: str, resource_dir: str):
        """
        初始化路径管理器（应用启动时调用一次）
        
        Args:
            config_dir: 配置目录路径字符串
            export_dir: 导出目录路径字符串
            resource_dir: 资源目录路径字符串
            
        Note:
            如果已经初始化过，会返回现有实例（幂等操作）
        """
        # ✅ 如果已经初始化过，直接返回现有实例（幂等操作）
        if cls._instance is not None:
            print(f"⚠️ [PathManager] 检测到重复初始化请求，返回现有实例")
            return cls._instance
        
        cls._instance = cls(
            Path(config_dir),
            Path(export_dir),
            Path(resource_dir)
        )
        
        print(f"✅ PathManager 初始化成功:")
        print(f"   CONFIG_DIR: {cls._instance.config_dir}")
        print(f"   EXPORT_DIR: {cls._instance.export_dir}")
        print(f"   RESOURCE_DIR: {cls._instance.resource_dir}")
        print(f"   DB_PATH: {cls._instance.db_path}")
        
        return cls._instance
    
    @classmethod
    def get_instance(cls):
        """
        获取路径管理器单例
        
        Returns:
            PathManager: 路径管理器实例
            
        Raises:
            RuntimeError: 如果尚未初始化
        """
        if cls._instance is None:
            raise RuntimeError(
                "PathManager 未初始化！\n"
                "请先在 capsule_api.py 中调用 PathManager.initialize()\n"
                "这是架构铁律：所有路径必须由 Tauri 通过命令行参数传入。"
            )
        return cls._instance
    
    def update_export_dir(self, new_export_dir: str):
        """
        动态更新导出目录（用于初始化后用户修改路径的场景）
        
        Args:
            new_export_dir: 新的导出目录路径
            
        Note:
            这个方法用于解决后端启动时配置尚未存在的问题。
            当用户在前端完成初始化后，调用此方法更新内存中的导出目录。
        """
        old_dir = self.export_dir
        self.export_dir = Path(new_export_dir)
        
        # 确保目录存在
        self.export_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"🔄 [PathManager] 导出目录已更新:")
        print(f"   旧路径: {old_dir}")
        print(f"   新路径: {self.export_dir}")
    
    def _check_database_schema(self) -> bool:
        """
        检查数据库表结构是否完整
        
        Returns:
            True 如果 capsules 表存在，False 否则
        """
        import sqlite3
        
        try:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            # 检查 capsules 表是否存在
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='capsules'")
            result = cursor.fetchone()
            
            conn.close()
            
            if result:
                return True
            else:
                print(f"⚠️ 数据库缺少 capsules 表")
                return False
                
        except Exception as e:
            print(f"⚠️ 检查数据库失败: {e}")
            return False
    
    def _init_database(self):
        """
        从 schema 文件初始化空数据库
        
        在首次启动时自动调用，确保用户无需手动复制数据库文件
        """
        import sqlite3
        
        try:
            # 检查 schema 文件是否存在
            if not self.schema_path.exists():
                print(f"⚠️ Schema 文件不存在: {self.schema_path}")
                print(f"   尝试从 resource_dir 的其他位置查找...")
                
                # 尝试其他可能的位置
                alt_paths = [
                    self.resource_dir / "capsule_schema.sql",
                    self.resource_dir.parent / "database" / "capsule_schema.sql",
                ]
                
                for alt_path in alt_paths:
                    if alt_path.exists():
                        self.schema_path = alt_path
                        print(f"✓ 找到 Schema: {alt_path}")
                        break
                else:
                    # 如果都找不到，创建一个最小化的数据库
                    print(f"⚠️ 无法找到 Schema 文件，创建最小化数据库...")
                    conn = sqlite3.connect(str(self.db_path))
                    conn.execute('''
                        CREATE TABLE IF NOT EXISTS capsules (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            title TEXT,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        )
                    ''')
                    conn.commit()
                    conn.close()
                    print(f"✓ 最小化数据库已创建: {self.db_path}")
                    return
            
            # 从 schema 创建数据库
            print(f"📄 读取 Schema: {self.schema_path}")
            with open(self.schema_path, 'r', encoding='utf-8') as f:
                schema_sql = f.read()
            
            conn = sqlite3.connect(str(self.db_path))
            conn.executescript(schema_sql)
            conn.commit()
            conn.close()
            
            print(f"✓ 数据库已初始化: {self.db_path}")
            
        except Exception as e:
            print(f"❌ 数据库初始化失败: {e}")
            # 不抛出异常，让应用继续启动（可能有其他方式恢复）
    
    def get_config_file(self, filename: str) -> Path:
        """获取配置文件路径"""
        return self.config_dir / filename
    
    def get_lua_script(self, script_name: str) -> Path:
        """获取 Lua 脚本路径"""
        return self.lua_scripts_dir / script_name


def load_user_config():
    """
    加载用户配置
    
    Returns:
        dict: 用户配置字典，如果读取失败返回空字典
    """
    try:
        pm = PathManager.get_instance()
        config_file = pm.get_config_file('config.json')
        
        if config_file.exists():
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
                return config
        else:
            return {}
    except RuntimeError:
        # PathManager 未初始化，返回空配置
        return {}
    except Exception as e:
        print(f"❌ 读取用户配置失败: {e}")
        return {}


# 向后兼容：保留旧的全局变量接口（deprecated）
# 新代码应该使用 PathManager.get_instance()
CONFIG_DIR = None
EXPORT_DIR = None
RESOURCE_DIR = None


def init_paths(config_dir, export_dir, resource_dir):
    """
    DEPRECATED: 请使用 PathManager.initialize() 代替
    
    为了向后兼容保留此函数
    """
    global CONFIG_DIR, EXPORT_DIR, RESOURCE_DIR
    CONFIG_DIR = Path(config_dir)
    EXPORT_DIR = Path(export_dir)
    RESOURCE_DIR = Path(resource_dir)
    
    # 只在 PathManager 未初始化时才初始化
    if PathManager._instance is None:
        PathManager.initialize(config_dir, export_dir, resource_dir)


class APIError(Exception):
    """API 错误基类"""
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def check_capsule_ownership(f):
    """
    权限控制装饰器：检查用户是否是胶囊所有者
    
    用法:
        @app.route('/api/capsules/<int:capsule_id>', methods=['PUT'])
        @check_capsule_ownership
        def update_capsule(capsule_id, current_user):
            # 只有所有者能执行
            pass
    
    装饰器会：
    1. 从 JWT token 获取当前用户 ID
    2. 从数据库查询胶囊的 owner_supabase_user_id
    3. 比较两者，不匹配则返回 403
    4. 匹配则继续执行，并注入 current_user 参数
    """
    from functools import wraps
    from flask import request, jsonify
    
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # 1. 获取认证 token
        auth_header = request.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return jsonify({
                'error': '缺少认证令牌',
                'code': 'UNAUTHORIZED'
            }), 401
        
        token = auth_header.split(' ')[1]
        
        # 2. 解析 token 获取用户信息
        try:
            from auth import get_auth_manager
            auth_manager = get_auth_manager()
            user_data = auth_manager.verify_token(token)
            
            if not user_data:
                return jsonify({
                    'error': '无效的认证令牌',
                    'code': 'INVALID_TOKEN'
                }), 401
            
            current_user_id = user_data.get('supabase_user_id') or str(user_data.get('user_id'))
            
        except Exception as e:
            return jsonify({
                'error': f'认证失败: {e}',
                'code': 'AUTH_ERROR'
            }), 401
        
        # 3. 获取胶囊 ID（从路由参数）
        capsule_id = kwargs.get('capsule_id')
        if not capsule_id:
            return jsonify({
                'error': '缺少胶囊 ID',
                'code': 'BAD_REQUEST'
            }), 400
        
        # 4. 查询胶囊所有者
        try:
            from capsule_db import get_database
            db = get_database()
            capsule = db.get_capsule(capsule_id)
            
            if not capsule:
                return jsonify({
                    'error': '胶囊不存在',
                    'code': 'NOT_FOUND'
                }), 404
            
            capsule_owner_id = capsule.get('owner_supabase_user_id')
            
            # 5. 检查权限
            if capsule_owner_id != current_user_id:
                return jsonify({
                    'error': '无权限修改他人的胶囊',
                    'code': 'FORBIDDEN',
                    'detail': {
                        'capsule_id': capsule_id,
                        'capsule_owner': capsule_owner_id,
                        'current_user': current_user_id
                    }
                }), 403
            
            # 6. 权限验证通过，注入 current_user 参数
            kwargs['current_user'] = user_data
            return f(*args, **kwargs)
            
        except Exception as e:
            return jsonify({
                'error': f'权限检查失败: {e}',
                'code': 'INTERNAL_ERROR'
            }), 500
    
    return decorated_function
