/**
 * 认证中心（2026-09-06 重写）
 * 公众号后台管理员扫码认证（mp_admin，官方通道）。
 * 旧微信读书账号池页面已随上游接口下线移除。
 */
const LoginPage = {
    _pollTimer: null,
    _statusTimer: null,

    render() {
        return `
        <div class="dashboard animate-fade-in">
            <div class="page-header">
                <h2 class="page-title">认证中心</h2>
                <p class="page-desc">公众号后台管理员扫码认证（官方通道）</p>
            </div>

            <div class="dash-grid">
                <!-- 凭证状态 -->
                <section class="dash-card" id="auth-status-card">
                    <h3 class="dash-card-title">凭证状态</h3>
                    <div id="login-status-body" class="dash-card-body"><p class="dash-muted">加载中…</p></div>
                    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
                        <button class="btn btn-secondary btn-sm" onclick="LoginPage.refreshStatus()">刷新状态</button>
                        <button class="btn btn-ghost btn-sm" onclick="LoginPage.checkCred()">校验有效性</button>
                        <button class="btn btn-ghost btn-sm" onclick="LoginPage.logout()">退出登录</button>
                    </div>
                </section>

                <!-- 扫码认证 -->
                <section class="dash-card" id="login-scan-card">
                    <h3 class="dash-card-title">扫码认证</h3>
                    <div id="login-scan-body" class="dash-card-body">
                        <p class="dash-muted">使用公众号管理员的微信扫码登录 mp.weixin.qq.com 后台。</p>
                        <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="LoginPage.startScan()">发起扫码认证</button>
                    </div>
                </section>

                <!-- 指引 -->
                <section class="dash-card dash-card-wide">
                    <h3 class="dash-card-title">认证后可以做什么</h3>
                    <div class="dash-card-body">
                        <div class="dash-row"><span class="dash-dot ok"></span>账号管理：按名称搜索公众号并收藏（官方 searchbiz）</div>
                        <div class="dash-row"><span class="dash-dot ok"></span>文章列表：查看收藏公众号的历史文章（官方 appmsg，新账号有数日频控期）</div>
                        <div class="dash-row"><span class="dash-dot ok"></span>订阅轮询：RSS 调度器定时增量采集收藏的公众号</div>
                        <div class="dash-extra-block">单篇文章采集不需要认证（公开页）——直接到
                            <a class="dash-more" href="#collect">采集</a> 页粘贴链接即可。</div>
                    </div>
                </section>
            </div>
        </div>`;
    },

    async init() {
        await this.refreshStatus();
        this._statusTimer = setInterval(() => this.refreshStatus(), 15000);
    },

    destroy() {
        if (this._statusTimer) clearInterval(this._statusTimer);
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._statusTimer = this._pollTimer = null;
    },

    _set(id, html) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    },

    async refreshStatus() {
        try {
            const m = await API.mpAdmin.status();
            const ok = !!m.credential_valid;
            const st = m.login_state || {};
            const scanning = st.status === 'scanning';
            let rows;
            if (ok) {
                rows = `<div class="dash-row"><span class="dash-dot ok"></span>已认证
                    ${m.nickname ? ' · ' + m.nickname : ''}
                    <span class="dash-extra">${m.save_time ? new Date(m.save_time * 1000).toLocaleString('zh-CN') : ''}</span></div>`;
            } else if (scanning && st.qr_image) {
                rows = `<div class="dash-row"><span class="dash-dot warn"></span>${st.message || '等待扫码'}</div>
                    <img class="dash-qr" src="${st.qr_image}" alt="二维码">`;
                if (!this._pollTimer) this._pollTimer = setInterval(() => this.refreshStatus(), 3000);
            } else if (st.status === 'success') {
                rows = `<div class="dash-row"><span class="dash-dot ok"></span>${st.message || '登录成功'}</div>`;
            } else if (st.status === 'failed') {
                rows = `<div class="dash-row"><span class="dash-dot bad"></span>${st.message || '登录失败'}</div>
                    <button class="btn btn-primary btn-sm" onclick="LoginPage.startScan()">重新发起</button>`;
            } else {
                rows = `<div class="dash-row"><span class="dash-dot bad"></span>未认证</div>
                    <button class="btn btn-primary btn-sm" onclick="LoginPage.startScan()">发起扫码认证</button>`;
            }
            this._set('login-status-body', rows);
        } catch (e) {
            this._set('login-status-body', '<p class="dash-muted">状态获取失败</p>');
        }
    },

    async startScan() {
        try {
            await API.authRequests.start('mp_admin');
            Toast.success('认证请求已创建，请扫码');
            if (this._statusTimer) clearInterval(this._statusTimer);
            await this.refreshStatus();
            if (this._statusTimer) clearInterval(this._statusTimer);
            this._statusTimer = setInterval(() => this.refreshStatus(), 3000);
        } catch (e) { /* toast 已报错 */ }
    },

    async checkCred() {
        try {
            const r = await API.mpAdmin.check();
            if (r.valid) Toast.success('凭证有效');
            else Toast.warning(r.message || '凭证已失效，请重新扫码');
            this.refreshStatus();
        } catch (e) { /* ignore */ }
    },

    async logout() {
        Modal.confirm('退出确认', '确定退出公众号后台登录吗？已收藏的公众号不受影响。', async () => {
            await API.mpAdmin.logout();
            Toast.success('已退出');
            this.refreshStatus();
        });
    },
};
