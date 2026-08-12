const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const tools = require("./tools");

class Cache {
  static getCachePath(projectName, key) {
    return paths.getCachePath(projectName, tools.safeFileName(key));
  }

  static read(projectName, key) {
    const file = this.getCachePath(projectName, key);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  }

  static readWithTTL(projectName, key, maxAgeMs = 30 * 24 * 3600 * 1000) {
    const file = this.getCachePath(projectName, key);
    if (!fs.existsSync(file)) return null;
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(file);
        return null;
      }
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  static write(projectName, key, data) {
    const file = this.getCachePath(projectName, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(data), "utf8");
    return true;
  }

  static cleanExpired(projectName, maxAgeMs = 30 * 24 * 3600 * 1000) {
    try {
      const dir = path.join(paths.cacheRoot, projectName);
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      const now = Date.now();
      for (const f of files) {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
        }
      }
    } catch (e) {
      // 忽略清理缓存失败
    }
  }
}

module.exports = Cache;
