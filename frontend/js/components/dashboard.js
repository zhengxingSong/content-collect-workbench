/**
 * 仪表盘（设计文档 §13）：一屏分区展示服务状态/账号池/待认证/最近收集/活跃任务。
 */
const DashboardPage = {
    _timers: [],

    render() {
        return `
        <div class="dashboard animate-fade-in">
            <div class="page-header">
                <h2 class="page-title">仪表盘</h2>
                <p class="page-desc">多来源数据收集平台总览</p>
            </div>

            <div class="dash-grid">
                <!-- 服务状态 -->
                <section class="dash-card" id="dash-services">
                    <h3 class="dash-card-title">服务状态</h3>
                    <div id="dash-services-body" class="dash-card-body"><p class="dash-muted">加载中…</p></div>
                </section>

                <!-- 账号池 -->
                <section class="dash-card" id="dash-accounts">
                    <h3 class="dash-card-title">采集账号池</h3>
                    <div id="dash-accounts-body" class="dash-card-body"><p class="dash-muted">加载中…</p></div>
                </section>

                <!-- 待认证请求 -->
                <section class="dash-card" id="dash-auth">
                    <h3 class="dash-card-title">待认证请求</h3>
                    <div id="dash-auth-body" class="dash-card-body"><p class="dash-muted">加载中…</p></div>
                </section>

                <!-- 活跃任务 -->
                <section class="dash-card" id="dash-tasks">
                    <h3 class="dash-card-title">活跃任务</h3>
                    <div id="dash-tasks-body" class="dash-card-body"><p class="dash-muted">加载中…</p></div>
                </section>

                <!-- 最近收集 -->
                <section class="dash-card dash-card-wide" id="dash-recent">
                    <h3 class="dash-card-title">最近收集 <a class="dash-more" href="#library">查看内容库 →</a></h3>
                    <div id="dash-recent-body" class="dash-card-body"><p class="dash-muted">加载中…</p></div>
                </section>
            </div>
        </div>`;
    },

    async init() {
        await this.refreshAll();
        // 仪表盘轻量轮询（5s），页面销毁时清理
        this._timers.push(setInterval(() => this.refreshServices(), 5000));
        this._timers.push(setInterval(() => this.refreshAuth(), 5000));
        this._timers.push(setInterval(() => this.refreshTasks(), 4000));
    },

    destroy() {
        this._timers.forEach(clearInterval);
        this._timers = [];
    },

    async refreshAll() {
        await Promise.all([this.refreshServices(), this.refreshAccounts(),
                           this.refreshAuth(), this.refreshTasks(), this.refreshRecent()]);
    },

    _set(id, html) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    },

    async refreshServices() {
        try {
            const s = await API.statusApi.get();
            const d = s.data || {};
            const row = (name, ok, extra) =>
                `<div class="dash-row"><span class="dash-dot ${ok ? 'ok' : 'bad'}"></span>${name}${extra ? `<span class="dash-extra">${extra}</span>` : ''}</div>`;
            this._set('dash-services-body', [
                row('后端服务', true, `${Math.round((d.backend?.uptime_seconds || 0) / 60)} 分钟`),
                row('MCP 服务', !!d.mcp?.ok, d.mcp?.ok ? `端口 ${d.mcp.port}` : '未运行'),
                row('RSS 调度器', !!d.scheduler?.ok, `订阅 ${d.scheduler?.subscriptions ?? '-'} 个`),
                row('FFmpeg', !!d.ffmpeg?.ok, ''),
                row('内容库', true, `${d.library?.entries ?? 0} 条`),
            ].join(''));
        } catch (e) {
            this._set('dash-services-body', '<p class="dash-muted">状态获取失败</p>');
        }
    },

    async refreshAccounts() {
        // 公众号后台管理员凭证（mp_admin，唯一官方通道）
        const rows = [];
        try {
            const m = await API.mpAdmin.status();
            const ok = !!m.credential_valid;
            const label = ok ? '有效' : (m.logged_in ? '已失效，请重新扫码' : '未登录');
            rows.push(`<div class="dash-row"><span class="dash-dot ${ok ? 'ok' : 'bad'}"></span>公众号后台（官方）
                ${m.nickname ? ' · ' + m.nickname : ''}<span class="dash-extra">${label}</span></div>`);
        } catch (e) {
            rows.push('<div class="dash-row"><span class="dash-dot bad"></span>公众号后台（官方）<span class="dash-extra">状态获取失败</span></div>');
        }
        rows.push('<div class="dash-extra-block"><a class="dash-more" href="#login">认证中心 →</a> <a class="dash-more" href="#accounts">账号管理 →</a></div>');
        this._set('dash-accounts-body', rows.join(''));
    },

    async refreshAuth() {
        try {
            const resp = await API.authRequests.pending();
            const list = (resp.data && resp.data.requests) || [];
            if (!list.length) {
                this._set('dash-auth-body',
                    '<p class="dash-muted">暂无待认证请求。公众号采集使用「公众号后台管理员扫码」（官方通道）。</p>' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
                    '<button class="btn btn-primary btn-sm" onclick="DashboardPage.startAuth(\'mp_admin\')">公众号后台扫码认证</button>' +
                    '</div>');
                return;
            }
            const html = list.map(r => `
                <div class="dash-auth-item">
                    <div class="dash-auth-info">
                        <div class="dash-row"><span class="dash-dot ${r.status === 'scanned' ? 'warn' : 'warn'}"></span>
                            ${this._platformName(r.platform)} · ${r.status === 'scanned' ? '已扫码' : '等待扫码'}</div>
                        <p class="dash-muted" style="margin:4px 0 8px">有效期至 ${new Date(r.expire_at * 1000).toLocaleTimeString()}</p>
                    </div>
                    ${r.qr_image ? `<img class="dash-qr" src="${r.qr_image}" alt="二维码">` : ''}
                    <div class="dash-auth-actions">
                        <button class="btn btn-secondary btn-sm" onclick="DashboardPage.refreshAuthReq('${r.platform}','${r.id}')">换新码</button>
                        <button class="btn btn-ghost btn-sm" onclick="DashboardPage.cancelAuthReq('${r.id}')">取消</button>
                    </div>
                </div>`).join('');
            this._set('dash-auth-body', html);
        } catch (e) {
            this._set('dash-auth-body', '<p class="dash-muted">待认证状态获取失败</p>');
        }
    },

    async refreshTasks() {
        try {
            const resp = await API.collect.tasks();
            const tasks = (resp.data && resp.data.tasks) || [];
            const active = tasks.filter(t => ['queued', 'running', 'waiting_auth', 'cancel_requested'].includes(t.status));
            if (!active.length) {
                const recentDone = tasks.slice(0, 3);
                this._set('dash-tasks-body', '<p class="dash-muted">暂无活跃任务</p>' +
                    (recentDone.length ? `<div class="dash-extra-block">最近：${recentDone.map(t =>
                        `<span class="dash-tag ${t.status}">${this._statusText(t.status)}</span> ${t.platform} #${t.task_id.slice(-6)}`).join(' ')}</div>` : ''));
                return;
            }
            this._set('dash-tasks-body', active.map(t => {
                const p = t.progress || {};
                return `<div class="dash-row">
                    <span class="dash-dot ${t.status === 'running' ? 'ok' : 'warn'}"></span>
                    ${t.platform} · ${p.done || 0}/${p.total || 0} · ${this._statusText(t.status)}
                    <button class="btn btn-ghost btn-sm" onclick="DashboardPage.cancelTask('${t.task_id}')">取消</button>
                </div>`;
            }).join(''));
        } catch (e) {
            this._set('dash-tasks-body', '<p class="dash-muted">任务状态获取失败</p>');
        }
    },

    async refreshRecent() {
        try {
            const resp = await API.library.list();
            const entries = ((resp.data && resp.data.entries) || []).slice(0, 8);
            if (!entries.length) {
                this._set('dash-recent-body', '<p class="dash-muted">内容库为空，去「采集」页粘贴链接开始收集。</p>');
                return;
            }
            this._set('dash-recent-body', `<table class="dash-table">
                <thead><tr><th>标题</th><th>来源</th><th>时间</th><th>状态</th><th></th></tr></thead>
                <tbody>${entries.map(e => `<tr>
                    <td title="${e.id}">${(e.title || '(无标题)').slice(0, 40)}</td>
                    <td>${e.author || '-'}</td>
                    <td>${(e.collect_time || '').slice(0, 16)}</td>
                    <td><span class="dash-tag ${e.collection_status}">${e.collection_status === 'complete' ? '完整' : '部分'}</span></td>
                    <td><button class="btn btn-ghost btn-sm" onclick="LibraryPage.openFolder('${e.id}')">打开</button></td>
                </tr>`).join('')}</tbody></table>`);
        } catch (e) {
            this._set('dash-recent-body', '<p class="dash-muted">内容库读取失败</p>');
        }
    },

    _statusText(s) {
        return ({ queued: '排队', running: '运行中', waiting_auth: '等待认证', cancel_requested: '取消中',
                  succeeded: '已完成', partially_succeeded: '部分成功', failed: '失败',
                  cancelled: '已取消', interrupted: '已中断' })[s] || s;
    },

    _platformName(p) {
        return ({ mp: '微信读书（已失效）', mp_admin: '公众号后台（推荐）' })[p] || p;
    },

    // ── 操作 ──────────────────────────────────────────
    async startAuth(platform) {
        try {
            await API.authRequests.start(platform || 'mp_admin');
            Toast.success('认证请求已创建，请扫码');
            this.refreshAuth();
        } catch (e) { /* toast 已报错 */ }
    },

    async refreshAuthReq(platform, id) {
        try {
            await API.authRequests.start(platform || 'mp_admin', true);
            Toast.success('已请求换新二维码');
            this.refreshAuth();
        } catch (e) { /* toast 已报错 */ }
    },

    async cancelAuthReq(id) {
        await API.authRequests.cancel(id);
        Toast.info('已取消');
        this.refreshAuth();
    },

    async cancelTask(taskId) {
        await API.collect.cancel(taskId);
        Toast.info('取消请求已受理（协作式）');
        this.refreshTasks();
    },
};
