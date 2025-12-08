type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_COLORS = {
  debug: "\x1b[90m", // gray
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  reset: "\x1b[0m",
};

class Logger {
  private level: LogLevel = "info";

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }

  private format(level: LogLevel, component: string, message: string): string {
    const timestamp = new Date().toISOString();
    const color = LOG_COLORS[level];
    const reset = LOG_COLORS.reset;
    return `${color}[${timestamp}] [${level.toUpperCase()}] [${component}]${reset} ${message}`;
  }

  debug(component: string, message: string, data?: unknown): void {
    if (this.shouldLog("debug")) {
      console.log(this.format("debug", component, message), data ?? "");
    }
  }

  info(component: string, message: string, data?: unknown): void {
    if (this.shouldLog("info")) {
      console.log(this.format("info", component, message), data ?? "");
    }
  }

  warn(component: string, message: string, data?: unknown): void {
    if (this.shouldLog("warn")) {
      console.warn(this.format("warn", component, message), data ?? "");
    }
  }

  error(component: string, message: string, data?: unknown): void {
    if (this.shouldLog("error")) {
      console.error(this.format("error", component, message), data ?? "");
    }
  }
}

export const logger = new Logger();
