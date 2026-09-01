// ==================== Notification Service ====================
// 支持 iPhone PWA（添加到主屏幕后）的通知功能
// 需要 iOS 16.4+ 且用户已将应用添加到主屏幕
// 注意：iOS 要求通知权限弹窗必须由用户手势（点击）触发，不能自动弹出

class NotificationService {
  constructor() {
    this.isSupported = 'Notification' in window;
    this.isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    this.swReady = false;
  }

  // 检查通知是否可用（不检查权限，只检查能力）
  isCapable() {
    if (!this.isSupported) return false;
    // iPhone/iPad 必须在 PWA 模式下才支持通知
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !this.isStandalone) return false;
    return true;
  }

  // 检查通知是否完全可用（能力 + 已授权）
  isAvailable() {
    if (!this.isCapable()) return false;
    return Notification.permission === 'granted';
  }

  // 获取当前权限状态
  getPermission() {
    if (!this.isSupported) return 'unsupported';
    return Notification.permission;
  }

  // 获取当前状态描述，供 UI 使用
  getStatus() {
    if (!this.isCapable()) return 'unsupported';
    const perm = Notification.permission;
    if (perm === 'granted') return 'granted';
    if (perm === 'denied') return 'denied';
    return 'default'; // 未决定
  }

  // 请求通知权限 —— 必须由用户点击事件调用
  async requestPermission() {
    if (!this.isCapable()) {
      return { success: false, reason: 'unsupported' };
    }

    if (Notification.permission === 'granted') {
      return { success: true, reason: 'already-granted' };
    }

    if (Notification.permission === 'denied') {
      return { success: false, reason: 'denied' };
    }

    // 确保 Service Worker 已就绪
    if (!this.swReady) {
      await this._registerSW();
    }

    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        return { success: true, reason: 'just-granted' };
      }
      return { success: false, reason: result };
    } catch (e) {
      console.error('[Notification] 请求权限失败:', e);
      return { success: false, reason: 'error' };
    }
  }

  // 发送通知
  send(title, body, options = {}) {
    if (!this.isAvailable()) {
      console.log('[Notification] 通知不可用');
      return false;
    }

    try {
      const notification = new Notification(title, {
        body,
        icon: options.icon || 'https://llee777.github.io/LOGO.png',
        badge: options.badge || 'https://llee777.github.io/LOGO.png',
        tag: options.tag || 'sticky-note',
        lang: 'zh-CN',
        requireInteraction: options.requireInteraction !== undefined ? options.requireInteraction : true,
        ...options,
      });

      notification.onclick = () => {
        window.focus();
        notification.close();
      };

      // 仅当未设置 requireInteraction 且未禁用 autoClose 时才自动关闭
      const shouldAutoClose = options.requireInteraction !== true && options.autoClose !== false;
      const autoClose = shouldAutoClose ? (options.autoClose || 5000) : 0;
      if (autoClose > 0) {
        setTimeout(() => notification.close(), autoClose);
      }

      return true;
    } catch (e) {
      console.error('[Notification] 发送失败:', e);
      return false;
    }
  }

  // 发送便利贴提醒通知
  sendNoteReminder(note) {
    const priorityNames = { 1: '紧急', 2: '重要', 3: '一般', 4: '较低', 5: '日常' };
    const priority = priorityNames[note.priority] || '一般';
    const content = note.content.length > 80
      ? note.content.substring(0, 80) + '...'
      : note.content;

    return this.send(
      `便利贴提醒 [${priority}]`,
      content,
      { tag: `note-${note.id}` }
    );
  }

  // 发送文本提示通知
  sendText(message) {
    return this.send('便利贴', message);
  }

  // 初始化：仅注册 Service Worker，不请求权限
  async init() {
    await this._registerSW();
    return this.getStatus();
  }

  // 注册 Service Worker
  async _registerSW() {
    if (this.swReady) return true;

    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        // 等待 Service Worker 激活
        if (reg.active) {
          this.swReady = true;
        } else {
          await new Promise((resolve) => {
            const sw = reg.installing || reg.waiting;
            if (!sw) { resolve(); return; }
            sw.addEventListener('statechange', function handler() {
              if (sw.state === 'activated') {
                this.swReady = true;
                sw.removeEventListener('statechange', handler);
                resolve();
              }
            });
            // 超时保护
            setTimeout(resolve, 3000);
          });
        }
        console.log('[Notification] Service Worker 已就绪');
        return true;
      } catch (e) {
        console.error('[Notification] Service Worker 注册失败:', e);
        return false;
      }
    }
    return false;
  }
}

// 导出全局实例
const notificationService = new NotificationService();
