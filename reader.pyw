# -*- coding: utf-8 -*-
"""
隐秘版小说阅读器 - 单文件执行
功能：
  1. 窗口始终置顶
  2. 鼠标悬浮显示，移开完全透明
  3. 仅支持 TXT 文件导入
  4. 单行显示，滚轮向下翻页
  5. 双击窗口打开文件，右键菜单退出
"""

import tkinter as tk
from tkinter import filedialog, messagebox
import os
import sys


class HiddenNovelReader:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("隐秘阅读器")

        # ---- 窗口基础设置 ----
        self.root.overrideredirect(True)              # 去掉标题栏
        self.root.attributes("-topmost", True)        # 始终置顶
        self.root.attributes("-alpha", 0.01)          # 初始几乎完全透明（0会导致鼠标事件丢失）
        self.root.geometry("600x40+800+200")          # 初始大小和位置，高度仅容纳一行

        # ---- 数据 ----
        self.lines = []          # 小说所有行
        self.current_idx = 0     # 当前行索引
        self.step = 1            # 每次滚动前进的行数
        self.transparent_alpha = 0.01
        self.visible_alpha = 0.98

        # ---- 单行显示标签 ----
        self.label = tk.Label(
            self.root,
            text="【双击此处导入 TXT 小说文件】",
            bg="black",
            fg="#E0E0E0",
            font=("Microsoft YaHei UI", 14),
            anchor="w",
            padx=12,
        )
        self.label.pack(fill="both", expand=True)

        # ---- 底部进度提示（很小的一条） ----
        self.progress_bar = tk.Label(
            self.root,
            text="",
            bg="#222222",
            fg="#888888",
            font=("Microsoft YaHei UI", 8),
            anchor="e",
            padx=6,
        )
        self.progress_bar.pack(fill="x")

        # ---- 事件绑定 ----
        self.root.bind("<Enter>", self._on_enter)
        self.root.bind("<Leave>", self._on_leave)
        self.label.bind("<Double-Button-1>", self.open_file)
        self.progress_bar.bind("<Double-Button-1>", self.open_file)

        # 鼠标滚轮 - 支持 Windows 和 Mac/Linux
        self.root.bind("<MouseWheel>", self._on_wheel_windows)
        self.root.bind("<Button-4>", self._on_wheel_linux_up)
        self.root.bind("<Button-5>", self._on_wheel_linux_down)

        # 键盘快捷键
        self.root.bind("<Up>", lambda e: self.scroll(-1))
        self.root.bind("<Down>", lambda e: self.scroll(1))
        self.root.bind("<Left>", lambda e: self.scroll(-5))
        self.root.bind("<Right>", lambda e: self.scroll(5))
        self.root.bind("<Escape>", lambda e: self.root.destroy())
        self.root.bind("<Control-o>", self.open_file)
        self.root.bind("<Control-plus>", self._bigger_font)
        self.root.bind("<Control-equal>", self._bigger_font)
        self.root.bind("<Control-minus>", self._smaller_font)
        self.root.bind("<Control-0>", self._reset_font)

        # ---- 右键菜单 ----
        self.menu = tk.Menu(self.root, tearoff=0)
        self.menu.add_command(label="打开 TXT 文件...", command=self.open_file, accelerator="Ctrl+O")
        self.menu.add_separator()
        self.menu.add_command(label="字号 增大", command=self._bigger_font, accelerator="Ctrl++")
        self.menu.add_command(label="字号 减小", command=self._smaller_font, accelerator="Ctrl+-")
        self.menu.add_command(label="字号 重置", command=self._reset_font, accelerator="Ctrl+0")
        self.menu.add_separator()
        self.menu.add_command(label="跳转到 开头", command=lambda: self._goto(0))
        self.menu.add_command(label="跳转到 结尾", command=lambda: self._goto(len(self.lines) - 1 if self.lines else 0))
        self.menu.add_separator()
        self.menu.add_command(label="退出 (Esc)", command=self.root.destroy)

        self.root.bind("<Button-3>", self._show_menu)   # 右键
        self.root.bind("<Button-2>", self._show_menu)   # Mac 中键

        # 拖动窗口 - 按住左键移动
        self._drag_x = 0
        self._drag_y = 0
        for w in (self.root, self.label, self.progress_bar):
            w.bind("<ButtonPress-1>", self._start_drag)
            w.bind("<B1-Motion>", self._do_drag)

        # 窗口尺寸自适应调整行高
        self.root.bind("<Configure>", self._on_resize)

        self.font_size = 14

    # ===================== 透明度控制 =====================
    def _on_enter(self, event):
        self.root.attributes("-alpha", self.visible_alpha)

    def _on_leave(self, event):
        # 判断鼠标是否真的离开了窗口（防止子控件边界触发）
        x, y = self.root.winfo_pointerxy()
        wx = self.root.winfo_x()
        wy = self.root.winfo_y()
        ww = self.root.winfo_width()
        wh = self.root.winfo_height()
        if not (wx <= x <= wx + ww and wy <= y <= wy + wh):
            self.root.attributes("-alpha", self.transparent_alpha)

    # ===================== 文件导入 =====================
    def open_file(self, event=None):
        filetypes = [("文本文件", "*.txt"), ("所有文件", "*.*")]
        path = filedialog.askopenfilename(title="选择 TXT 小说文件", filetypes=filetypes)
        if not path:
            return
        if not path.lower().endswith(".txt"):
            messagebox.showwarning("提示", "仅支持 TXT 格式文件！")
            return
        try:
            with open(path, "rb") as f:
                raw = f.read()
            # 尝试常见编码
            text = None
            for enc in ("utf-8", "utf-8-sig", "gbk", "gb18030", "big5", "latin-1"):
                try:
                    text = raw.decode(enc)
                    break
                except UnicodeDecodeError:
                    continue
            if text is None:
                raise UnicodeDecodeError("unknown", b"", 0, 1, "无法识别的编码")
        except Exception as e:
            messagebox.showerror("错误", f"读取文件失败：\n{e}")
            return

        # 按行分割，去除空行并合并过长的换行
        raw_lines = text.splitlines()
        self.lines = [ln.strip() for ln in raw_lines if ln.strip()]
        # 合并段落：如果一行不是以。！？.!?结尾且下一行存在，则续接（启发式）
        merged = []
        buf = ""
        punc = ("。", "！", "？", ".", "!", "?", "…", "”", "」", "』", "）", ")")
        for ln in self.lines:
            if not buf:
                buf = ln
            elif buf.endswith(punc) or ln.startswith(("“", "「", "『", "（", "(", "—", "-", "　")):
                merged.append(buf)
                buf = ln
            else:
                buf += ln
        if buf:
            merged.append(buf)
        # 如果合并后反而太少（比如单字单行排版），回退到原始
        if len(merged) < max(5, len(self.lines) // 10):
            self.lines = [ln.strip() for ln in raw_lines if ln.strip()]
        else:
            self.lines = merged

        self.current_idx = 0
        self._render()

        # 更新标题
        name = os.path.basename(path)
        self.root.title(f"隐秘阅读器 - {name}")

    # ===================== 渲染单行 =====================
    def _render(self):
        if not self.lines:
            self.label.config(text="【双击此处导入 TXT 小说文件】")
            self.progress_bar.config(text="")
            return
        if self.current_idx < 0:
            self.current_idx = 0
        if self.current_idx >= len(self.lines):
            self.current_idx = len(self.lines) - 1
        line = self.lines[self.current_idx]
        self.label.config(text=line)
        total = len(self.lines)
        pct = (self.current_idx + 1) / total * 100
        self.progress_bar.config(text=f"{self.current_idx + 1} / {total}  ({pct:.1f}%)")

    # ===================== 滚动 =====================
    def scroll(self, delta):
        if not self.lines:
            return
        self.current_idx += delta
        self._render()

    def _goto(self, idx):
        self.current_idx = idx
        self._render()

    def _on_wheel_windows(self, event):
        # Windows: delta 正数 = 向上滚，我们要“往下滑翻下一页” => 向上滚=前进
        direction = 1 if event.delta > 0 else -1
        # 约定：滚轮往上（向前推）显示下一行，这样更符合看手机时手指向上滑=内容向下移
        self.scroll(direction * self.step)

    def _on_wheel_linux_up(self, event):
        self.scroll(self.step)

    def _on_wheel_linux_down(self, event):
        self.scroll(-self.step)

    # ===================== 字号 =====================
    def _bigger_font(self):
        self.font_size = min(48, self.font_size + 2)
        self.label.config(font=("Microsoft YaHei UI", self.font_size))

    def _smaller_font(self):
        self.font_size = max(8, self.font_size - 2)
        self.label.config(font=("Microsoft YaHei UI", self.font_size))

    def _reset_font(self):
        self.font_size = 14
        self.label.config(font=("Microsoft YaHei UI", self.font_size))

    # ===================== 右键菜单 =====================
    def _show_menu(self, event):
        try:
            self.menu.tk_popup(event.x_root, event.y_root)
        finally:
            self.menu.grab_release()

    # ===================== 拖动窗口 =====================
    def _start_drag(self, event):
        self._drag_x = event.x_root - self.root.winfo_x()
        self._drag_y = event.y_root - self.root.winfo_y()

    def _do_drag(self, event):
        x = event.x_root - self._drag_x
        y = event.y_root - self._drag_y
        self.root.geometry(f"+{x}+{y}")

    # ===================== 尺寸改变自适应 =====================
    def _on_resize(self, event):
        # 窗口变宽时自动缩放字号（仅自动增大到合适比例）
        pass

    # ===================== 主循环 =====================
    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    app = HiddenNovelReader()
    app.run()
