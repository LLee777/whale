// Popup脚本 - 处理弹窗逻辑
document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const uuidEl = document.getElementById('uuid');
  const sourceEl = document.getElementById('source');
  const refreshBtn = document.getElementById('refreshBtn');
  const clearBtn = document.getElementById('clearBtn');

  // 获取当前活动标签页
  async function getCurrentTab() {
    if (typeof chrome === 'undefined' || !chrome.tabs) {
      throw new Error('请在浏览器插件环境中使用');
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // 向content script发送消息获取指纹信息
  async function getFingerprintInfo() {
    try {
      const tab = await getCurrentTab();

      if (!tab || !tab.id) {
        throw new Error('无法获取当前标签页');
      }

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getFingerprint' });
      return response;
    } catch (error) {
      console.error('获取指纹信息失败:', error);
      throw error;
    }
  }

  // 清除指纹
  async function clearFingerprint() {
    try {
      const tab = await getCurrentTab();

      if (!tab || !tab.id) {
        throw new Error('无法获取当前标签页');
      }

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'clearFingerprint' });
      return response;
    } catch (error) {
      console.error('清除指纹失败:', error);
      throw error;
    }
  }

  // 更新UI显示
  function updateUI(data) {
    if (data && data.uuid) {
      statusEl.textContent = '已激活';
      statusEl.className = 'status active';
      uuidEl.textContent = data.uuid;
      uuidEl.className = 'uuid-display';
      sourceEl.textContent = `来源: ${data.source === 'cookie' ? 'Cookies' : 'IndexedDB'}`;
    } else {
      statusEl.textContent = '未激活';
      statusEl.className = 'status inactive';
      uuidEl.textContent = '未检测到指纹UUID';
      uuidEl.className = 'uuid-display empty';
      sourceEl.textContent = '';
    }
  }

  // 刷新检测
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '检测中...';
    
    try {
      const data = await getFingerprintInfo();
      updateUI(data);
    } catch (error) {
      uuidEl.textContent = '检测失败: ' + error.message;
      uuidEl.className = 'uuid-display empty';
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '刷新检测';
    }
  });

  // 清除指纹
  clearBtn.addEventListener('click', async () => {
    if (!confirm('确定要清除当前指纹吗？这将生成新的指纹UUID。')) {
      return;
    }

    clearBtn.disabled = true;
    clearBtn.textContent = '清除中...';
    
    try {
      await clearFingerprint();
      // 刷新显示
      const data = await getFingerprintInfo();
      updateUI(data);
    } catch (error) {
      alert('清除失败: ' + error.message);
    } finally {
      clearBtn.disabled = false;
      clearBtn.textContent = '清除指纹';
    }
  });

  // 初始加载时获取指纹信息
  try {
    const data = await getFingerprintInfo();
    updateUI(data);
  } catch (error) {
    uuidEl.textContent = '无法连接到页面，请刷新页面后重试';
    uuidEl.className = 'uuid-display empty';
  }
});
