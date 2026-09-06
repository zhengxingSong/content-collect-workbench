/**
 * 内容库（设计文档 §13 内容库区）：output/ 浏览 + 历史登记展示 + 导出。
 * 预览使用 sandbox iframe（§4：采集 HTML 不在桌面特权页面执行脚本）。
 */
const LibraryPage = {
    _entries: [],
    _filter: { platform: '', date: '' },

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
                <input type="date" id="lib-date" class="input" style="max-width:170px" onchange="LibraryPage.setDate(this.value)">
                <button class="btn btn-secondary btn-sm" onclick="LibraryPage.refresh()">刷新</button>
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
                this.refresh();
            });
        });
        await this.refresh();
    },

    setDate(v) { this._filter.date = v; this.refresh(); },

    async refresh() {
        const box = document.getElementById('lib-table');
        try {
            const resp = await API.library.list(this._filter.platform || undefined, this._filter.date || undefined);
            this._entries = (resp.data && resp.data.entries) || [];
            if (!this._entries.length) {
                box.innerHTML = '<p class="dash-muted">暂无条目。在「采集」页粘贴链接即可开始收集。</p>';
                return;
            }
            box.innerHTML = `<table class="dash-table">
                <thead><tr><th>标题</th><th>平台</th><th>作者</th><th>发布时间</th><th>收集时间</th><th>状态</th><th style="min-width:180px">操作</th></tr></thead>
                <tbody>${this._entries.map(e => `<tr>
                    <td title="entry_id: ${this._esc(e.id)}">${this._esc((e.title || '(无标题)').slice(0, 44))}</td>
                    <td>${this._platformName(e.platform)}</td>
                    <td>${this._esc(e.author || '-')}</td>
                    <td>${this._esc((e.publish_time || '').slice(0, 10) || '-')}</td>
                    <td>${this._esc((e.collect_time || '').slice(0, 16))}</td>
                    <td><span class="dash-tag ${e.collection_status}">${e.collection_status === 'complete' ? '完整' : '部分'}</span></td>
                    <td>
                        <button class="btn btn-ghost btn-sm" data-act="preview" data-id="${this._escAttr(e.id)}">预览</button>
                        <button class="btn btn-ghost btn-sm" data-act="download" data-id="${this._escAttr(e.id)}">下载打包</button>
                        <button class="btn btn-ghost btn-sm" data-act="folder" data-id="${this._escAttr(e.id)}">打开目录</button>
                    </td>
                </tr>`).join('')}</tbody></table>`;
            // 事件委托：外部数据不拼进内联 onclick，统一从此处按 data-act 分发
            box.querySelectorAll('button[data-act]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.dataset.id, act = btn.dataset.act;
                    if (act === 'preview') this.preview(id);
                    else if (act === 'download') window.open(`/api/library/entries/${encodeURIComponent(id)}/download`, '_blank');
                    else if (act === 'folder') this.openFolder(id);
                });
            });
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
