/**
 * 内容库（设计文档 §13 内容库区）：output/ 浏览 + 历史登记展示 + 导出。
 * 预览使用 sandbox iframe（§4：采集 HTML 不在桌面特权页面执行脚本）。
 */
const LibraryPage = {
    _entries: [],
    _filter: { platform: '', date: '', q: '', page: 1, pageSize: 20 },
    _selected: new Set(),

    render() {
        return `
        <div class="dashboard animate-fade-in">
            <div class="page-header">
                <h2 class="page-title">内容库</h2>
                <p class="page-desc">已收集条目（output/ 即对外契约，下游可直接消费）</p>
            </div>

            <div class="lib-toolbar">
                <div class="lib-tabs" id="lib-platform-tabs">
                    <button class="lib-tab active" data-platform="">全部</button>
                    <button class="lib-tab" data-platform="mp">公众号</button>
                    <button class="lib-tab" data-platform="channels">视频号</button>
                    <button class="lib-tab" data-platform="douyin">抖音</button>
                    <button class="lib-tab" data-platform="ks">快手</button>
                    <button class="lib-tab" data-platform="xhs">小红书</button>
                    <button class="lib-tab" data-platform="bili">B站</button>
                </div>
                <div class="lib-search-row" style="display:flex;gap:8px;align-items:center;margin-top:12px">
                    <input id="lib-search" class="input" style="flex:1" placeholder="搜索标题或作者…" maxlength="100">
                    <button class="btn btn-primary btn-sm" id="lib-search-btn">搜索</button>
                    <button class="btn btn-ghost btn-sm" id="lib-search-clear">清空</button>
                </div>
                <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
                    <input type="date" id="lib-date" class="input" style="max-width:170px">
                    <button class="btn btn-secondary btn-sm" id="lib-refresh">刷新</button>
                    <button class="btn btn-secondary btn-sm" id="lib-select-all">全选本页</button>
                    <button class="btn btn-primary btn-sm" id="lib-batch-download">导出选中</button>
                    <button class="btn btn-ghost btn-sm" id="lib-backup">备份内容库</button>
                    <button class="btn btn-ghost btn-sm" id="lib-restore">恢复备份</button>
                    <span id="lib-count" class="dash-muted"></span>
                </div>
            </div>

            <div class="dash-card">
                <div id="lib-table" class="dash-card-body"><p class="dash-muted">加载中…</p></div>
            </div>
        </div>`;
    },

    async init() {
        document.querySelectorAll('#lib-platform-tabs .lib-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#lib-platform-tabs .lib-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._filter.platform = btn.dataset.platform;
                this._filter.page = 1;
                this.refresh();
            });
        });
        const search = document.getElementById('lib-search');
        const runSearch = () => { this._filter.q = (search?.value || '').trim(); this._filter.page = 1; this.refresh(); };
        document.getElementById('lib-search-btn')?.addEventListener('click', runSearch);
        search?.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
        document.getElementById('lib-search-clear')?.addEventListener('click', () => {
            if (search) search.value = '';
            this._filter.q = ''; this._filter.page = 1; this.refresh();
        });
        document.getElementById('lib-date')?.addEventListener('change', e => {
            this._filter.date = e.target.value; this._filter.page = 1; this.refresh();
        });
        document.getElementById('lib-refresh')?.addEventListener('click', () => this.refresh());
        document.getElementById('lib-select-all')?.addEventListener('click', () => {
            this._entries.forEach(e => this._selected.add(e.id));
            document.querySelectorAll('#lib-table input[data-select-id]').forEach(x => { x.checked = true; });
        });
        document.getElementById('lib-batch-download')?.addEventListener('click', () => this.batchDownload());
        document.getElementById('lib-backup')?.addEventListener('click', () => this.backup());
        document.getElementById('lib-restore')?.addEventListener('click', () => this.restore());
        await this.refresh();
    },

    setDate(v) { this._filter.date = v; this._filter.page = 1; this.refresh(); },

    async refresh() {
        const box = document.getElementById('lib-table');
        try {
            const resp = await API.library.list(
                this._filter.platform || undefined, this._filter.date || undefined,
                this._filter.q || undefined, this._filter.page, this._filter.pageSize);
            const payload = (resp.data && resp.data.entries)
                ? resp.data : { entries: [], total: 0, page: 1, page_size: this._filter.pageSize, has_more: false };
            this._entries = payload.entries || [];
            this._total = payload.total || this._entries.length;
            const count = document.getElementById('lib-count');
            if (count) count.textContent = `共 ${this._total} 条 · 第 ${payload.page || this._filter.page} 页`;
            if (!this._entries.length) {
                box.innerHTML = '<p class="dash-muted">暂无匹配条目。在「采集」页粘贴链接即可开始收集。</p>';
                return;
            }
            box.innerHTML = `<table class="dash-table">
                <thead><tr><th><input type="checkbox" id="lib-check-header"></th><th>标题</th><th>平台</th><th>作者</th><th>发布时间</th><th>收集时间</th><th>状态</th><th style="min-width:210px">操作</th></tr></thead>
                <tbody>${this._entries.map(e => `<tr>
                    <td><input type="checkbox" data-select-id="${this._escAttr(e.id)}" ${this._selected.has(e.id) ? 'checked' : ''}></td>
                    <td title="entry_id: ${this._esc(e.id)}">${this._esc((e.title || '(无标题)').slice(0, 44))}</td>
                    <td>${this._platformName(e.platform)}</td>
                    <td>${this._esc(e.author || '-')}</td>
                    <td>${this._esc((e.publish_time || '').slice(0, 10) || '-')}</td>
                    <td>${this._esc((e.collect_time || '').slice(0, 16))}</td>
                    <td><span class="dash-tag ${e.collection_status}">${e.collection_status === 'complete' ? '完整' : '部分'}</span></td>
                    <td>
                        <button class="btn btn-ghost btn-sm" data-act="preview" data-id="${this._escAttr(e.id)}">预览</button>
                        <button class="btn btn-ghost btn-sm" data-act="detail" data-id="${this._escAttr(e.id)}">详情</button>
                        <button class="btn btn-ghost btn-sm" data-act="download" data-id="${this._escAttr(e.id)}">下载打包</button>
                        <button class="btn btn-ghost btn-sm" data-act="folder" data-id="${this._escAttr(e.id)}">打开目录</button>
                    </td>
                </tr>`).join('')}</tbody></table>`;
            // 事件委托：外部数据不拼进内联 onclick，统一从此处按 data-act 分发
            box.querySelectorAll('button[data-act]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.dataset.id, act = btn.dataset.act;
                    if (act === 'preview') this.preview(id);
                    else if (act === 'detail') this.detail(id);
                    else if (act === 'download') window.open(`/api/library/entries/${encodeURIComponent(id)}/download`, '_blank');
                    else if (act === 'folder') this.openFolder(id);
                });
            });
            box.querySelectorAll('input[data-select-id]').forEach(input => {
                input.addEventListener('change', () => {
                    if (input.checked) this._selected.add(input.dataset.selectId);
                    else this._selected.delete(input.dataset.selectId);
                });
            });
            box.querySelector('#lib-check-header')?.addEventListener('change', e => {
                box.querySelectorAll('input[data-select-id]').forEach(input => {
                    input.checked = e.target.checked;
                    if (input.checked) this._selected.add(input.dataset.selectId);
                    else this._selected.delete(input.dataset.selectId);
                });
            });
            const pages = Math.max(1, Math.ceil(this._total / this._filter.pageSize));
            if (pages > 1) {
                box.insertAdjacentHTML('beforeend', `<div class="lib-pagination" style="display:flex;gap:10px;justify-content:center;align-items:center;margin-top:14px">
                    <button class="btn btn-ghost btn-sm" data-page="prev" ${this._filter.page <= 1 ? 'disabled' : ''}>上一页</button>
                    <span class="dash-muted">第 ${this._filter.page} / ${pages} 页</span>
                    <button class="btn btn-ghost btn-sm" data-page="next" ${this._filter.page >= pages ? 'disabled' : ''}>下一页</button>
                </div>`);
                box.querySelector('[data-page="prev"]')?.addEventListener('click', () => { this._filter.page--; this.refresh(); });
                box.querySelector('[data-page="next"]')?.addEventListener('click', () => { this._filter.page++; this.refresh(); });
            }
        } catch (e) {
            box.innerHTML = '<p class="dash-muted">内容库读取失败</p>';
        }
    },

    // 文本转义：所有可能来自外部平台的非可信字段必须先 _esc 再进 innerHTML
    _esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    _escAttr(s) {
        return this._esc(s);
    },

    _platformName(p) {
        return ({ mp: '公众号', channels: '视频号', douyin: '抖音', ks: '快手', xhs: '小红书', bili: 'B站' })[p] || p;
    },

    async batchDownload() {
        const ids = [...this._selected];
        if (!ids.length) { Toast.warning('请先选择要导出的条目'); return; }
        const url = `/api/library/entries/batch-download`;
        const w = window.open('', '_blank');
        try {
            const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entry_ids: ids }) });
            if (!resp.ok) throw new Error('批量导出失败');
            const blob = await resp.blob();
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'library-export.zip'; a.click();
            URL.revokeObjectURL(a.href); this._selected.clear(); Toast.success(`已导出 ${ids.length} 个条目`);
        } catch (e) { if (w) w.close(); Toast.error(e.message || '批量导出失败'); }
    },

    async backup() {
        try {
            const r = await API.library.backup();
            if (r.success) Toast.success(`备份完成：${r.data.file_count} 个文件（服务端 data/backups）`);
            else Toast.error(r.error?.message || '备份失败');
        } catch (e) { Toast.error(e.message || '备份失败'); }
    },

    async restore() {
        const path = window.prompt('请输入服务端备份 ZIP 的绝对路径（不会恢复登录凭证）：');
        if (!path) return;
        try {
            const v = await API.library.validateRestore(path);
            if (!v.success) { Toast.error(v.error?.message || '备份校验失败'); return; }
            if (!window.confirm(`校验通过：${v.data.file_count} 个文件。确认合并恢复？登录凭证不会恢复。`)) return;
            const r = await API.library.restore(path, 'merge', true);
            if (r.success) { Toast.success(`恢复完成：${r.data.restored_entries} 个条目`); this.refresh(); }
            else Toast.error(r.error?.message || '恢复失败');
        } catch (e) { Toast.error(e.message || '恢复失败'); }
    },

    async detail(entryId) {
        try {
            const resp = await API.library.get(entryId);
            const entry = (resp.data && resp.data.entry) || {};
            const integrity = entry.integrity || {};
            const statusLabel = { complete: '完整', partial: '部分完整', corrupt: '文件损坏' }[integrity.status] || '未校验';
            const statusClass = integrity.status === 'complete' ? 'ok' : (integrity.status === 'corrupt' ? 'bad' : 'warn');
            const files = (integrity.files || []).map(f => `<tr><td>${this._esc(f.path)}</td><td>${this._esc(f.status)}</td><td>${this._esc(f.reason || '—')}</td></tr>`).join('');
            const warnings = (integrity.warnings || []).map(w => `<li>${this._esc(w)}</li>`).join('');
            Modal.open({
                title: `${this._esc(entry.title || '(无标题)')} · 完整性详情`,
                content: `<div class="lib-detail">
                    <p><span class="dash-dot ${statusClass}"></span> ${statusLabel} · ${integrity.ok_count || 0}/${integrity.file_count || 0} 个文件校验通过</p>
                    <p class="dash-muted">平台：${this._esc(entry.platform)} · 作者：${this._esc((entry.author || {}).name || '—')} · 采集：${this._esc(entry.collect_time || '—')}</p>
                    <table class="dash-table"><thead><tr><th>文件</th><th>校验</th><th>说明</th></tr></thead><tbody>${files || '<tr><td colspan="3">无文件清单</td></tr>'}</tbody></table>
                    ${warnings ? `<p><b>警告</b></p><ul>${warnings}</ul>` : ''}
                    ${(integrity.failed_items || []).length ? `<button class="btn btn-primary btn-sm" id="lib-retry-media">补采失败的 ${integrity.failed_items.length} 个媒体</button>` : ''}
                </div>`,
                onOpen: () => {
                    document.getElementById('lib-retry-media')?.addEventListener('click', async () => {
                        try {
                            const r = await API.library.retryMedia(entryId);
                            if (r.success) { Toast.success(r.summary); Modal.close(); this.detail(entryId); }
                            else Toast.error(r.error?.message || '补采失败');
                        } catch (e) { Toast.error(e.message || '补采失败'); }
                    });
                },
            });
        } catch (e) {
            Toast.error(e.message || '读取完整性详情失败');
        }
    },

    async preview(entryId) {
        const meta = await API.library.get(entryId);
        const entry = (meta.data && meta.data.entry) || {};
        const hasBody = (entry.files || []).some(f => f.path.startsWith('content.'));
        if (!hasBody) { Toast.warning('该条目无可预览正文'); return; }
        // 单一预览方式：新窗口全页阅读（沙箱禁脚本 + CSP 防护仍然生效）。
        // 不用 iframe 弹窗，避免与 window.open 双重打开且产生未定义变量引用。
        const previewUrl = `/api/library/entries/${encodeURIComponent(entryId)}/preview`;
        const w = window.open(previewUrl, '_blank');
        if (!w) { Toast.warning('弹窗被浏览器拦截，请允许本站弹出窗口后重试'); }
    },

    async openFolder(entryId) {
        const r = await API.library.openFolder(entryId);
        if (r.success && r.data && r.data.supported === false) {
            Modal.open({
                title: '容器模式提示',
                content: `<p style="line-height:1.8">当前服务运行在 Docker 容器中，无法直接打开宿主机文件管理器。</p>
                    <p style="line-height:1.8">宿主机路径：<code>${this._esc(r.data.path)}</code></p>
                    <p style="line-height:1.8">可改用条目操作里的「下载打包」获取完整文件。</p>`,
            });
        } else if (r.success) {
            Toast.success('已打开目录');
        } else {
            Toast.error(r.error?.message || '打开失败');
        }
    },
};
