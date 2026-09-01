    // ==================== Database Manager ====================
    class DatabaseManager {
      constructor() {
        this.dbName = 'StickyNotesDB';
        this.storeName = 'notes';
        this.db = null;
      }

      async init() {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(this.dbName, 2);
          request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(this.storeName)) {
              const store = db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
              store.createIndex('createdAt', 'createdAt', { unique: false });
              store.createIndex('priority', 'priority', { unique: false });
              store.createIndex('completed', 'completed', { unique: false });
            }
          };
          request.onsuccess = (event) => {
            this.db = event.target.result;
            resolve();
          };
          request.onerror = (event) => reject(event.target.error);
        });
      }

      async add(note) {
        return this._transaction('readwrite', (store) => store.add(note));
      }

      async update(note) {
        return this._transaction('readwrite', (store) => store.put(note));
      }

      async delete(id) {
        return this._transaction('readwrite', (store) => store.delete(id));
      }

      async get(id) {
        return this._transaction('readonly', (store) => {
          return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        });
      }

      async getAll() {
        return this._transaction('readonly', (store) => {
          return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        });
      }

      async getPaginated(page, pageSize, filter, sortBy, search) {
        let notes = await this.getAll();

        // Filter by completion status
        if (filter === 'pending') {
          notes = notes.filter(n => !n.completed);
        } else if (filter === 'completed') {
          notes = notes.filter(n => n.completed);
        }

        // Search by content
        if (search && search.trim()) {
          const keyword = search.trim().toLowerCase();
          notes = notes.filter(n => n.content.toLowerCase().includes(keyword));
        }

        // Sort
        if (sortBy === 'priority') {
          notes.sort((a, b) => a.priority - b.priority || b.createdAt - a.createdAt);
        } else {
          notes.sort((a, b) => b.createdAt - a.createdAt);
        }

        const total = notes.length;
        const totalPages = Math.ceil(total / pageSize) || 1;
        const start = (page - 1) * pageSize;
        const items = notes.slice(start, start + pageSize);

        return { items, total, totalPages, page };
      }

      async getStats() {
        const notes = await this.getAll();
        const total = notes.length;
        const completed = notes.filter(n => n.completed).length;
        const pending = total - completed;
        return { total, completed, pending };
      }

      _transaction(mode, callback) {
        return new Promise((resolve, reject) => {
          const tx = this.db.transaction(this.storeName, mode);
          const store = tx.objectStore(this.storeName);
          const result = callback(store);
          if (result instanceof Promise) {
            result.then(resolve).catch(reject);
          } else {
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
          }
        });
      }
    }

    // ==================== Time Service ====================
    class TimeService {
      static async getNetworkTime() {
        // Try worldtimeapi first
        try {
          const res = await fetch('https://worldtimeapi.org/api/timezone/Asia/Shanghai', {
            signal: AbortSignal.timeout(3000)
          });
          if (res.ok) {
            const data = await res.json();
            return new Date(data.utc_datetime).getTime();
          }
        } catch (e) { /* fallback */ }

        // Fallback: local time
        return Date.now();
      }
    }

    // ==================== Reminder Service ====================
    // 定时扫描便利贴，到期未提醒的自动发送通知
    //
    // 后台节流策略：
    //   浏览器在标签页切到后台时会节流 setInterval/setTimeout，
    //   通常降到约 1 次/分钟（iOS PWA 更严，可能完全暂停）。
    //   本服务采用以下机制应对：
    //   1. 使用递归 setTimeout 替代 setInterval，避免回调堆积
    //   2. 记录 lastCheckTime，应用回到前台时若距上次检查 >= 1 分钟，
    //      立即触发补发检查
    //   3. check() 为全量扫描，确保后台期间积压的到期提醒一次性补发
    //
    // 限制：应用完全关闭后定时器停止，只能等下次启动时补扫。
    class ReminderService {
      constructor(db) {
        this.db = db;
        this.timer = null;
        this.intervalMs = 30 * 1000; // 前台检查间隔（30秒）
        this.catchUpThresholdMs = 60 * 1000; // 距上次检查 >= 1 分钟触发补发
        this._checking = false;
        this.lastCheckTime = Date.now();
      }

      // 启动定时器，并立即执行一次补扫
      start() {
        if (this.timer) return;
        this.check(); // 启动时立即检查一次（处理离线期间到期未提醒的）
        this._scheduleNext(); // 递归调度，替代 setInterval

        // 应用回到前台：检测后台节流期间是否需要补发
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState !== 'visible') return;
          const elapsed = Date.now() - this.lastCheckTime;
          // 距上次检查 >= 1 分钟，判定为可能经历了后台节流，立即补发
          if (elapsed >= this.catchUpThresholdMs) {
            this.check();
          }
        });
      }

      stop() {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
      }

      // 递归 setTimeout 调度：每次检查完成后才安排下一次，
      // 避免后台节流恢复后 setInterval 堆积多次回调
      _scheduleNext() {
        this.timer = setTimeout(async () => {
          await this.check();
          this._scheduleNext();
        }, this.intervalMs);
      }

      async check() {
        if (this._checking) return;
        if (typeof notificationService === 'undefined') return;
        this._checking = true;
        try {
          const notes = await this.db.getAll();
          const now = Date.now();
          // 全量扫描：所有到期未提醒未完成的便利贴都需补发
          const due = notes.filter(n =>
            n.reminderTime && !n.reminded && !n.completed && n.reminderTime <= now
          );
          for (const note of due) {
            const sent = notificationService.sendNoteReminder(note);
            if (sent) {
              note.reminded = true;
              note.remindedAt = now;
              await this.db.update(note);
            }
          }
          this.lastCheckTime = now;
        } catch (e) {
          console.error('[Reminder] 检查失败:', e);
        } finally {
          this._checking = false;
        }
      }
    }


    // ==================== UI Manager ====================
    class UIManager {
      constructor(db) {
        this.db = db;
        this.currentPage = 1;
        this.pageSize = 10;
        this.currentFilter = 'all';
        this.currentSort = 'time';
        this.searchKeyword = '';
        this.editingNote = null;

        this.els = {
          noteList: document.getElementById('noteList'),
          pagination: document.getElementById('pagination'),
          prevBtn: document.getElementById('prevBtn'),
          nextBtn: document.getElementById('nextBtn'),
          pageInfo: document.getElementById('pageInfo'),
          emptyState: document.getElementById('emptyState'),
          stats: document.getElementById('stats'),
          searchInput: document.getElementById('searchInput'),
          sortBtn: document.getElementById('sortBtn'),
          sortLabel: document.getElementById('sortLabel'),
          fabBtn: document.getElementById('fabBtn'),
          modalOverlay: document.getElementById('modalOverlay'),
          modalSheet: document.getElementById('modalSheet'),
          modalTitle: document.getElementById('modalTitle'),
          noteContent: document.getElementById('noteContent'),
          prioritySelector: document.getElementById('prioritySelector'),
          cancelBtn: document.getElementById('cancelBtn'),
          saveBtn: document.getElementById('saveBtn'),
          confirmOverlay: document.getElementById('confirmOverlay'),
          confirmDialog: document.getElementById('confirmDialog'),
          confirmMessage: document.getElementById('confirmMessage'),
          confirmCancel: document.getElementById('confirmCancel'),
          confirmOk: document.getElementById('confirmOk'),
          toast: document.getElementById('toast'),
          notifyBtn: document.getElementById('notifyBtn'),
          testNotifyBtn: document.getElementById('testNotifyBtn'),
          reminderTimeInput: document.getElementById('reminderTimeInput'),
          reminderClearBtn: document.getElementById('reminderClearBtn'),
        };

        this.selectedPriority = 3;
        this._confirmResolve = null;
        this._isSaving = false; // 保存状态锁

        this.bindEvents();
      }

      bindEvents() {
        // Search
        let searchTimer;
        this.els.searchInput.addEventListener('input', () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => {
            this.searchKeyword = this.els.searchInput.value;
            this.currentPage = 1;
            this.loadNotes();
          }, 300);
        });

        // Filter tabs
        document.querySelectorAll('.filter-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            this.currentFilter = tab.dataset.filter;
            this.currentPage = 1;
            this.loadNotes();
          });
        });

        // Sort
        this.els.sortBtn.addEventListener('click', () => {
          this.currentSort = this.currentSort === 'time' ? 'priority' : 'time';
          this.els.sortLabel.textContent = this.currentSort === 'time' ? '时间' : '优先级';
          this.loadNotes();
        });

        // Pagination
        this.els.prevBtn.addEventListener('click', () => {
          if (this.currentPage > 1) {
            this.currentPage--;
            this.loadNotes();
          }
        });
        this.els.nextBtn.addEventListener('click', () => {
          this.currentPage++;
          this.loadNotes();
        });

        // FAB
        this.els.fabBtn.addEventListener('click', () => this.openCreateModal());

        // Modal
        this.els.modalOverlay.addEventListener('click', () => this.closeModal());
        this.els.cancelBtn.addEventListener('click', () => this.closeModal());
        this.els.saveBtn.addEventListener('click', () => this.saveNote());

        // Notification button
        if (this.els.notifyBtn) {
          this.els.notifyBtn.addEventListener('click', () => this.requestNotification());
        }
        // Test notification button
        if (this.els.testNotifyBtn) {
          this.els.testNotifyBtn.addEventListener('click', () => this.testNotification());
        }

        // Priority selector
        this.els.prioritySelector.querySelectorAll('.priority-option').forEach(opt => {
          opt.addEventListener('click', () => {
            this.els.prioritySelector.querySelectorAll('.priority-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            this.selectedPriority = parseInt(opt.dataset.priority);
          });
        });

        // Confirm dialog
        this.els.confirmCancel.addEventListener('click', () => this._closeConfirm(false));
        this.els.confirmOk.addEventListener('click', () => this._closeConfirm(true));
        this.els.confirmOverlay.addEventListener('click', () => this._closeConfirm(false));

        // Reminder time input
        this.els.reminderTimeInput.addEventListener('input', () => {
          this.els.reminderClearBtn.parentElement.classList.toggle(
            'has-value',
            !!this.els.reminderTimeInput.value
          );
        });
        this.els.reminderClearBtn.addEventListener('click', () => {
          this.els.reminderTimeInput.value = '';
          this.els.reminderClearBtn.parentElement.classList.remove('has-value');
        });
      }

      async loadNotes() {
        try {
          const result = await this.db.getPaginated(
            this.currentPage, this.pageSize,
            this.currentFilter, this.currentSort,
            this.searchKeyword
          );

          this.renderNotes(result.items);
          this.renderPagination(result);
          this.updateStats();

          if (result.total === 0) {
            this.els.emptyState.style.display = 'block';
            this.els.noteList.style.display = 'none';
          } else {
            this.els.emptyState.style.display = 'none';
            this.els.noteList.style.display = 'flex';
          }
        } catch (e) {
          console.error('Load notes error:', e);
          this.showToast('加载失败，请重试');
        }
      }

      renderNotes(notes) {
        this.els.noteList.innerHTML = notes.map(note => this.renderNoteCard(note)).join('');

        // Bind card actions
        this.els.noteList.querySelectorAll('.note-card').forEach(card => {
          const id = parseInt(card.dataset.id);

          card.querySelector('.complete-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleComplete(id);
          });

          card.querySelector('.copy-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyContent(id);
          });

          card.querySelector('.edit-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openEditModal(id);
          });

          card.querySelector('.delete-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteNote(id);
          });
        });
      }

      renderNoteCard(note) {
        const priorityColors = { 1: 'var(--p1)', 2: 'var(--p2)', 3: 'var(--p3)', 4: 'var(--p4)', 5: 'var(--p5)' };
        const priorityNames = { 1: '紧急', 2: '重要', 3: '一般', 4: '较低', 5: '日常' };
        const color = priorityColors[note.priority] || priorityColors[3];
        const name = priorityNames[note.priority] || '一般';
        const time = this.formatTime(note.createdAt);
        const completedClass = note.completed ? 'completed' : '';
        const completeIcon = note.completed
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>';
        const completeBtnClass = note.completed ? 'complete-btn completed-action' : 'complete-btn';

        // 提醒时间标识
        let reminderTag = '';
        if (note.reminderTime) {
          const triggered = note.reminded;
          const bellIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
          reminderTag = `<span class="note-reminder ${triggered ? 'triggered' : ''}" title="${triggered ? '已提醒' : '待提醒'}">${bellIcon}${this.formatReminderTime(note.reminderTime)}</span>`;
        }

        return `
          <div class="note-card ${completedClass}" data-id="${note.id}">
            <div class="priority-bar" style="background:${color}"></div>
            <div class="note-header">
              <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
                <span class="priority-badge" style="background:${color}">${name}</span>
              </div>
              <div class="note-actions">
                <button class="action-btn copy-btn" title="复制" aria-label="复制内容">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                </button>
                <button class="action-btn ${completeBtnClass}" title="完成" aria-label="切换完成状态">
                  ${completeIcon}
                </button>
                <button class="action-btn edit-btn" title="编辑" aria-label="编辑">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                </button>
                <button class="action-btn delete-btn" title="删除" aria-label="删除">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                </button>
              </div>
            </div>
            <div class="note-content">${this.escapeHtml(note.content)}</div>
            <div class="note-meta">
              <span>${time}</span>
              ${reminderTag}
            </div>
          </div>
        `;
      }

      renderPagination(result) {
        const { total, totalPages, page } = result;
        if (totalPages <= 1) {
          this.els.pagination.style.display = 'none';
        } else {
          this.els.pagination.style.display = 'flex';
          this.els.prevBtn.disabled = page <= 1;
          this.els.nextBtn.disabled = page >= totalPages;
          this.els.pageInfo.textContent = `${page} / ${totalPages}`;
        }
      }

      async updateStats() {
        const stats = await this.db.getStats();
        this.els.stats.textContent = `${stats.total} 条记录`;
      }

      openCreateModal() {
        this.editingNote = null;
        this.els.modalTitle.textContent = '新建便利贴';
        this.els.noteContent.value = '';
        this.selectedPriority = 3;

        this.resetPrioritySelector();
        this.resetReminderInput();

        this.showModal();
      }

      async openEditModal(id) {
        const note = await this.db.get(id);
        if (!note) return;

        this.editingNote = note;
        this.els.modalTitle.textContent = '编辑便利贴';
        this.els.noteContent.value = note.content;
        this.selectedPriority = note.priority;

        // Update priority selector
        this.els.prioritySelector.querySelectorAll('.priority-option').forEach(opt => {
          opt.classList.toggle('selected', parseInt(opt.dataset.priority) === note.priority);
        });

        // 回填提醒时间
        this.setReminderInputValue(note.reminderTime || null);

        this.showModal();
      }

      async saveNote() {
        // 防止重复提交
        if (this._isSaving) return;
        this._isSaving = true;
        this.els.saveBtn.disabled = true;
        this.els.saveBtn.textContent = '保存中...';

        try {
          const content = this.els.noteContent.value.trim();
          if (!content) {
            this.showToast('请输入内容');
            this.els.noteContent.focus();
            return;
          }

          const now = await TimeService.getNetworkTime();
          const reminderTime = this.parseReminderInputValue();
          // 校验提醒时间不能早于当前时间
          if (reminderTime && reminderTime < now) {
            this.showToast('提醒时间需晚于当前时间');
            this.els.reminderTimeInput.focus();
            return;
          }

          if (this.editingNote) {
            // Update
            const oldReminderTime = this.editingNote.reminderTime || null;
            this.editingNote.content = content;
            this.editingNote.priority = this.selectedPriority;
            this.editingNote.updatedAt = now;
            // 提醒时间变化时重置已提醒状态
            if (reminderTime !== oldReminderTime) {
              this.editingNote.reminderTime = reminderTime;
              this.editingNote.reminded = false;
            }
            await this.db.update(this.editingNote);
            this.showToast('已更新');
          } else {
            // Create
            const note = {
              content,
              priority: this.selectedPriority,
              completed: false,
              createdAt: now,
              updatedAt: now,
              reminderTime: reminderTime,
              reminded: false,
            };
            await this.db.add(note);
            this.showToast('已创建');
          }

          this.closeModal();
          this.loadNotes();
        } finally {
          this._isSaving = false;
          this.els.saveBtn.disabled = false;
          this.els.saveBtn.textContent = '保存';
        }
      }

      async toggleComplete(id) {
        const note = await this.db.get(id);
        if (!note) return;
        note.completed = !note.completed;
        note.updatedAt = await TimeService.getNetworkTime();
        await this.db.update(note);
        this.showToast(note.completed ? '已完成' : '已恢复');
        this.loadNotes();
      }

      async copyContent(id) {
        const note = await this.db.get(id);
        if (!note) return;
        try {
          await navigator.clipboard.writeText(note.content);
          this.showToast('已复制到剪贴板');
        } catch {
          // Fallback
          const ta = document.createElement('textarea');
          ta.value = note.content;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          this.showToast('已复制到剪贴板');
        }
      }

      async deleteNote(id) {
        const confirmed = await this.showConfirm('确定要删除这条便利贴吗？');
        if (!confirmed) return;
        await this.db.delete(id);
        this.showToast('已删除');
        // Adjust page if needed
        const stats = await this.db.getStats();
        const totalPages = Math.ceil(stats.total / this.pageSize) || 1;
        if (this.currentPage > totalPages) this.currentPage = totalPages;
        this.loadNotes();
      }

      showModal() {
        this.els.modalOverlay.classList.add('active');
        this.els.modalSheet.classList.add('active');
        document.body.style.overflow = 'hidden';
        setTimeout(() => this.els.noteContent.focus(), 350);
      }

      closeModal() {
        this.els.modalOverlay.classList.remove('active');
        this.els.modalSheet.classList.remove('active');
        document.body.style.overflow = '';
      }

      showConfirm(message) {
        return new Promise((resolve) => {
          this.els.confirmMessage.textContent = message;
          this.els.confirmOverlay.classList.add('active');
          this.els.confirmDialog.classList.add('active');
          this._confirmResolve = resolve;
        });
      }

      _closeConfirm(result) {
        this.els.confirmOverlay.classList.remove('active');
        this.els.confirmDialog.classList.remove('active');
        if (this._confirmResolve) {
          this._confirmResolve(result);
          this._confirmResolve = null;
        }
      }

      showToast(message) {
        this.els.toast.textContent = message;
        this.els.toast.classList.add('show');
        setTimeout(() => this.els.toast.classList.remove('show'), 2000);
      }

      resetPrioritySelector() {
        this.els.prioritySelector.querySelectorAll('.priority-option').forEach(opt => {
          opt.classList.toggle('selected', parseInt(opt.dataset.priority) === 3);
        });
      }

      // 清空提醒时间输入框
      resetReminderInput() {
        this.els.reminderTimeInput.value = '';
        this.els.reminderClearBtn.parentElement.classList.remove('has-value');
      }

      // 将时间戳回填到 datetime-local 输入框
      setReminderInputValue(timestamp) {
        if (!timestamp) {
          this.resetReminderInput();
          return;
        }
        this.els.reminderTimeInput.value = this.toLocalDatetimeString(new Date(timestamp));
        this.els.reminderClearBtn.parentElement.classList.add('has-value');
      }

      // 解析输入框值为时间戳，空值返回 null
      parseReminderInputValue() {
        const v = this.els.reminderTimeInput.value;
        if (!v) return null;
        const t = new Date(v).getTime();
        return isNaN(t) ? null : t;
      }

      // 格式化提醒时间用于卡片显示
      formatReminderTime(timestamp) {
        const d = new Date(timestamp);
        const now = new Date();
        const sameYear = d.getFullYear() === now.getFullYear();
        const md = `${d.getMonth() + 1}/${d.getDate()}`;
        const hm = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        return sameYear ? `${md} ${hm}` : `${d.getFullYear()}/${md} ${hm}`;
      }

      formatTime(timestamp) {
        const d = new Date(timestamp);
        const now = new Date();
        const diff = now - d;

        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
        if (diff < 86400000 && d.getDate() === now.getDate()) {
          return `今天 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        }

        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth()) {
          return `昨天 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        }

        return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
      }

      toLocalDatetimeString(date) {
        const pad = n => n.toString().padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
      }

      escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      // 请求通知权限（必须由用户点击触发）
      async requestNotification() {
        if (typeof notificationService === 'undefined') return;

        const result = await notificationService.requestPermission();
        
        if (result.success) {
          this.showToast('通知已开启');
          notificationService.sendText('便利贴通知已开启，重要提醒不会错过！');
          this.updateNotifyButton();
        } else {
          if (result.reason === 'denied') {
            this.showToast('通知权限被拒绝，请在系统设置中开启');
          } else if (result.reason === 'unsupported') {
            this.showToast('当前环境不支持通知');
          } else {
            this.showToast('通知开启失败');
          }
        }
      }

      // 更新通知按钮状态
      updateNotifyButton() {
        if (typeof notificationService === 'undefined' || !this.els.notifyBtn) return;

        const status = notificationService.getStatus();
        const btn = this.els.notifyBtn;

        btn.style.display = 'flex';

        if (status === 'granted') {
          btn.classList.add('granted');
          btn.querySelector('span').textContent = '已开启';
          if (this.els.testNotifyBtn) {
            this.els.testNotifyBtn.style.display = 'flex';
          }
        } else {
          btn.classList.remove('granted');
          btn.querySelector('span').textContent = '开启通知';
          if (this.els.testNotifyBtn) {
            this.els.testNotifyBtn.style.display = 'none';
          }
        }
      }

      // 测试发送通知
      async testNotification() {
        if (typeof notificationService === 'undefined') {
          this.showToast('通知服务未加载');
          return;
        }

        if (!notificationService.isAvailable()) {
          this.showToast('请先开启通知权限');
          return;
        }

        const sent = notificationService.sendText('这是一条测试通知，通知功能正常工作！');
        
        if (sent) {
          this.showToast('测试通知已发送，请查看通知栏');
        } else {
          this.showToast('发送失败，请重试');
        }
      }
    }

    // ==================== App Init ====================
    async function initApp() {
      const db = new DatabaseManager();
      await db.init();

      const ui = new UIManager(db);
      await ui.loadNotes();

      // 初始化通知服务
      if (typeof notificationService !== 'undefined') {
        await notificationService.init();
        // 更新通知按钮状态
        ui.updateNotifyButton();
      }

      // 启动提醒服务：定时扫描到期未提醒的便利贴
      const reminderService = new ReminderService(db);
      reminderService.start();
      // 暴露到全局便于调试
      window.__reminderService = reminderService;


      // 页面隐藏时发送状态通知
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden') {
          if (typeof notificationService === 'undefined' || !notificationService.isAvailable()) return;
          
          const stats = await db.getStats();
          const pendingCount = stats.pending || (stats.total - stats.completed);
          
          if (pendingCount > 0) {
            notificationService.send(
              '便利贴状态',
              `您有 ${pendingCount} 条未完成的便利贴`,
              { tag: 'page-hidden-status', autoClose: 5000 }
            );
          } else {
            notificationService.send(
              '便利贴状态',
              `当前共有 ${stats.total} 条便利贴，全部已完成`,
              { tag: 'page-hidden-status', autoClose: 4000 }
            );
          }
        }
      });
    }

    initApp().catch(console.error);
