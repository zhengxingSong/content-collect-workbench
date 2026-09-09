/**
 * 统一采集（设计文档 §13 采集区）：粘贴任意平台链接 → 自动识别 → 提交任务；
 * 订阅管理；各平台高级页入口。
 */
const CollectPage = {
    _pollTimer: null,
    _submitted: [],   // {taskId, platform, url}

    render() {
        return `
        <div class="dashboard animate-fade-in">
            <div class="page-header">
                <h2 class="page-title">采集</h2>
                <p class="page-desc">粘贴链接即可识别平台并提交采集任务</p>
            </div>

            <div class="dash-card">
                <h3 class="dash-card-title">统一下载入口</h3>
                <div class="dash-card-body">
                    <textarea id="collect-input" class="input" rows="4" style="width:100%;resize:vertical"
                        placeholder="每行一个链接，支持：&#10;https://mp.weixin.qq.com/s/... （公众号，归一化入库 output/）&#10;https://www.douyin.com/video/... / https://www.bilibili.com/video/BV... / 快手 / 小红书链接（走对应平台解析下载）"></textarea>
                    <div style="display:flex;gap:10px;margin-top:10px;align-items:center">
                        <button class="btn btn-primary" onclick="CollectPage.submit()">识别并采集</button>
                        <span id="collect-hint" class="dash-muted"></span>
                    </div>
                    <div id="collect-results" style="margin-top:14px"></div>
                </div>
            </div>

            <div class="dash-card" style="margin-top:16px" id="collect-submitted-card" hidden>
                <h3 class="dash-card-title">提交的任务</h3>
                <div id="collect-submitted" class="dash-card-body"></div>
            </div>

            <div class="dash-grid" style="margin-top:16px">
                <section class="dash-card" id="collect-subscriptions-card">
                    <h3 class="dash-card-title">公众号订阅 <a class="dash-more" href="#accounts">从公众号管理添加 →</a></h3>
                    <div id="collect-subscriptions" class="dash-card-body"><p class="dash-muted">加载中…</p></div>
                </section>

                <section class="dash-card" id="collect-hot-card">
                    <h3 class="dash-card-title">公众号爆款洞察 <span class="dash-muted" style="font-weight:400;font-size:.75rem">第三方公开快照库 · 免登录 · 每日更新</span></h3>
                    <div class="dash-card-body">
                        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                            <input id="hot-keyword" class="input" style="flex:1;min-width:160px"
                                placeholder="赛道关键词（建议细分词，如「AI Agent」；留空=全站热门）"
                                onkeydown="if(event.key==='Enter')CollectPage.queryHot()" />
                            <select id="hot-days" class="input" style="width:auto">
                                <option value="7">近 7 天</option>
                                <option value="14">近 14 天</option>
                                <option value="30">近 30 天</option>
                            </select>
                            <button class="btn btn-primary" onclick="CollectPage.queryHot()">查询</button>
                        </div>
                        <div id="hot-results" style="margin-top:12px"><p class="dash-muted">查询后按数据分排序展示（阅读/分享/点赞为入库快照，仅供参考）。</p></div>
                    </div>
                </section>

                <section class="dash-card" id="collect-sogou-card">
                    <h3 class="dash-card-title">公众号近期文章 <span class="dash-muted" style="font-weight:400;font-size:.75rem">搜狗公开索引 · 免登录 · 输入公众号名</span></h3>
                    <div class="dash-card-body">
                        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                            <input id="sogou-name" class="input" style="flex:1;min-width:160px"
                                placeholder="公众号显示名（精确匹配，如「腾讯技术工程」）"
                                onkeydown="if(event.key==='Enter')CollectPage.querySogou()" />
                            <button class="btn btn-primary" onclick="CollectPage.querySogou()">搜索</button>
                        </div>
                        <div id="sogou-results" style="margin-top:12px"><p class="dash-muted">返回该号近期文章（非全量历史）；签名链接有时效，请尽快采集。</p></div>
                    </div>
                </section>

                <section class="dash-card">
                    <h3 class="dash-card-title">平台高级功能</h3>
                    <div class="dash-card-body">
                        <div class="adv-links">
                            <a href="#articles" class="adv-link">公众号批量下载</a>
                            <a href="#channels" class="adv-link">视频号采集</a>
                            <a href="#dy_dashboard" class="adv-link">抖音工作台</a>
                            <a href="#ks_parse" class="adv-link">快手解析</a>
                            <a href="#xhs_download" class="adv-link">小红书下载</a>
                            <a href="#bili_download" class="adv-link">B站下载</a>
                            <a href="#transcode" class="adv-link">视频转码</a>
                        </div>
                    </div>
                </section>
            </div>
        </div>`;
    },

    async init() {
        await this.refreshSubscriptions();
        this.refreshSubmitted();
        this._pollTimer = setInterval(() => this.refreshSubmitted(), 4000);
    },

    destroy() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = null;
    },

    _parseLines() {
        const raw = document.getElementById('collect-input').value || '';
        return [...new Set(raw.split(/\s+/).map(s => s.trim()).filter(s => s.startsWith('http')))];
    },

    async submit() {
        const urls = this._parseLines();
        const hint = document.getElementById('collect-hint');
        if (!urls.length) { hint.textContent = '请先粘贴至少一个链接'; return; }
        hint.textContent = `共 ${urls.length} 个链接，识别中…`;

        // 1. 统一识别
        const detected = [];
        for (const url of urls) {
            const r = await API.collect.detectUrl(url).catch(() => null);
            detected.push({ url, result: r });
        }
        const unsupported = detected.filter(d => !d.result || !d.result.data || d.result.data.supported === false);
        const supported = detected.filter(d => d.result && d.result.data && d.result.data.supported);

        // 2. 分派：mp → 统一采集（output/）；其余平台 → 各平台单条下载
        const results = [];
        const mpUrls = supported.filter(d => d.result.data.platform === 'mp').map(d => d.url);
        if (mpUrls.length) {
            const r = await API.collect.mp(mpUrls).catch(e => ({ success: false, error: { message: e.message } }));
            results.push({ kind: 'mp', urls: mpUrls, resp: r });
            if (r.success) this._submitted.push({ taskId: r.data.task_id, platform: 'mp', count: mpUrls.length });
        }
        for (const d of supported) {
            const p = d.result.data.platform;
            if (p === 'douyin') {
                const r = await API.douyin.downloadSingle(d.url).catch(e => ({ success: false, error: { message: e.message } }));
                results.push({ kind: p, urls: [d.url], resp: { success: !!r.success, summary: r.success ? '已提交抖音解析下载' : (r.error?.message || '提交失败') } });
            } else if (p === 'bilibili') {
                const r = await API.bili.downloadSingle(d.url).catch(e => ({ success: false, error: { message: e.message } }));
                results.push({ kind: p, urls: [d.url], resp: { success: !!r.success, summary: r.success ? '已提交B站解析下载' : (r.error?.message || '提交失败') } });
            } else if (p === 'kuaishou') {
                const r = await API.kuaishou.downloadSingle(d.url).catch(e => ({ success: false, error: { message: e.message } }));
                results.push({ kind: p, urls: [d.url], resp: { success: !!r.success, summary: r.success ? '已提交快手解析下载' : (r.error?.message || '提交失败') } });
            } else if (p === 'xiaohongshu') {
                const r = await API.xhs.download([d.url]).catch(e => ({ success: false, error: { message: e.message } }));
                results.push({ kind: p, urls: [d.url], resp: { success: !!r.success, summary: r.success ? '已提交小红书下载' : (r.error?.message || '提交失败') } });
            } else if (p === 'channels') {
                results.push({ kind: p, urls: [d.url], resp: { success: false, summary: '视频号请使用「视频号采集」页（依赖代理环境）' } });
            }
        }
        for (const d of unsupported) {
            results.push({ kind: 'unknown', urls: [d.url], resp: { success: false, summary: '无法识别的平台链接' } });
        }

        hint.textContent = '完成';
        this._renderResults(results);
        this.refreshSubmitted();
    },

    _renderResults(results) {
        const box = document.getElementById('collect-results');
        box.innerHTML = results.map(r => `
            <div class="dash-row" style="align-items:flex-start">
                <span class="dash-dot ${r.resp.success ? 'ok' : 'bad'}"></span>
                <div>
                    <div>${r.resp.summary || (r.resp.success ? '已提交' : '失败')}</div>
                    ${r.kind === 'mp' ? `<div class="dash-muted">任务 ${r.resp.data?.task_id || ''}（提交成功≠采集成功，见下方任务列表/仪表盘）</div>` : ''}
                    <div class="dash-muted" style="word-break:break-all">${r.urls.map(u => u.slice(0, 90)).join('<br>')}</div>
                </div>
            </div>`).join('');
    },

    async refreshSubmitted() {
        const card = document.getElementById('collect-submitted-card');
        const box = document.getElementById('collect-submitted');
        if (!card || !box) return;
        if (!this._submitted.length) { card.hidden = true; return; }
        card.hidden = false;
        const rows = [];
        for (const item of this._submitted) {
            const r = await API.collect.task(item.taskId).catch(() => null);
            if (!r || !r.data || !r.data.task) continue;
            const t = r.data.task;
            const p = t.progress || {};
            const done = ['succeeded', 'partially_succeeded', 'failed', 'cancelled'].includes(t.status);
            rows.push(`<div class="dash-row">
                <span class="dash-dot ${['succeeded'].includes(t.status) ? 'ok' : (['running', 'queued'].includes(t.status) ? 'warn' : 'bad')}"></span>
                任务 #${t.task_id.slice(-6)}：${p.done || 0}/${p.total || 0} · ${({ queued: '排队', running: '采集中', succeeded: '完成', partially_succeeded: '部分成功', failed: '失败', cancelled: '已取消' })[t.status] || t.status}
                ${!done ? `<button class="btn btn-ghost btn-sm" onclick="CollectPage.cancel('${t.task_id}')">取消</button>` : ''}
            </div>`);
        }
        box.innerHTML = rows.join('') || '<p class="dash-muted">加载中…</p>';
    },

    async cancel(taskId) {
        await API.collect.cancel(taskId);
        Toast.info('取消请求已受理');
        this.refreshSubmitted();
    },

    async refreshSubscriptions() {
        const box = document.getElementById('collect-subscriptions');
        try {
            const resp = await API.rssApi.subscriptions();
            const subs = (resp.data && resp.data.subscriptions) || [];
            if (!subs.length) {
                box.innerHTML = '<p class="dash-muted">暂无订阅。可在「公众号管理」页为公众号开启 RSS 订阅，调度器将定时增量采集。</p>';
                return;
            }
            box.innerHTML = subs.map(s => `
                <div class="dash-row">
                    <span class="dash-dot ok"></span> ${s.nickname || s.fakeid}
                    <span class="dash-extra">${s.interval_minutes || 60} 分钟/次</span>
                    <button class="btn btn-ghost btn-sm" onclick="CollectPage.removeSub('${s.fakeid}')">移除</button>
                </div>`).join('');
        } catch (e) {
            box.innerHTML = '<p class="dash-muted">订阅读取失败</p>';
        }
    },

    async removeSub(fakeid) {
        Modal.confirm('移除订阅', `确定移除订阅 ${fakeid}？`, async () => {
            await API.rssApi.unsubscribe(fakeid);
            Toast.success('已移除');
            this.refreshSubscriptions();
        });
    },

    // ── 公众号爆款洞察（借鉴 creator-buddy 数据获取方式） ──
    async queryHot() {
        const box = document.getElementById('hot-results');
        const keyword = (document.getElementById('hot-keyword')?.value || '').trim();
        const days = parseInt(document.getElementById('hot-days')?.value || '7', 10);
        box.innerHTML = '<p class="dash-muted">查询中…</p>';
        try {
            const resp = await API.mpHot.query(keyword, days, 20);
            const items = resp.items || [];
            if (!items.length) {
                box.innerHTML = '<p class="dash-muted">该关键词近 ' + days + ' 天暂无爆款数据。建议换用更细分或更贴近平台热词的关键词（泛词如「AI」往往查不到，细分词如「AI Agent」更有效）。</p>';
                return;
            }
            box.innerHTML = `
                <p class="dash-muted">共 ${items.length} 条（去重后）· 按数据分排序 · 点击「采集原文」进入统一采集管线。<br>
                注意：爆款库提供的是长链接，微信可能对服务端抓取弹出环境校验（环境异常/参数错误）；若采集失败，点「原文」在浏览器打开后复制短链（mp.weixin.qq.com/s/…）到上方统一下载入口重采。</p>
                ${items.map(it => `
                <div class="dash-row" style="align-items:flex-start">
                    <span class="dash-dot ok"></span>
                    <div style="flex:1">
                        <div>${CollectPage._esc(it.title)}</div>
                        <div class="dash-muted">
                            ${CollectPage._esc(it.account_name || '未知账号')} · ${CollectPage._esc(it.publish_time.slice(0, 10))}
                            · 阅读 ${CollectPage._esc(it.reads)} · 分享 ${it.shares} · 点赞 ${it.likes}
                            · ${CollectPage._esc(it.category)} · 数据分 ${it.data_score}
                        </div>
                    </div>
                    <span style="display:flex;gap:6px;white-space:nowrap">
                        <button class="btn btn-ghost btn-sm" onclick="CollectPage.collectHot('${CollectPage._escAttr(it.link)}')">采集原文</button>
                        <a class="btn btn-ghost btn-sm" href="${CollectPage._escAttr(it.link)}" target="_blank" rel="noreferrer">原文</a>
                    </span>
                </div>`).join('')}`;
        } catch (e) {
            box.innerHTML = `<p class="dash-muted">查询失败：${CollectPage._esc(e.message || e)}（第三方接口不稳定，可稍后重试）</p>`;
        }
    },

    async collectHot(link) {
        const r = await API.collect.mp([link]).catch(e => ({ success: false, error: { message: e.message } }));
        if (r.success) {
            this._submitted.push({ taskId: r.data.task_id, platform: 'mp', count: 1 });
            Toast.success('已提交采集，见「提交的任务」');
            this.refreshSubmitted();
        } else {
            Toast.error(r.error?.message || '提交失败');
        }
    },

    // ── 搜狗公开索引（公众号近期文章） ────────────────────
    async querySogou() {
        const box = document.getElementById('sogou-results');
        const name = (document.getElementById('sogou-name')?.value || '').trim();
        if (!name) { Toast.warning('请输入公众号显示名'); return; }
        box.innerHTML = '<p class="dash-muted">搜索中…（含链接还原，约 5-15 秒）</p>';
        try {
            const r = await API.sogou.search(name, 10);
            const items = r.items || [];
            if (!items.length) {
                box.innerHTML = '<p class="dash-muted">索引中暂无该号的近期文章（发布者需精确匹配；可尝试完整显示名）。</p>';
                return;
            }
            box.innerHTML = `
                <p class="dash-muted">${items.length} 条已按发布者精确过滤 · ${r.resolved} 条已还原真实链接</p>
                ${items.map(it => `
                <div class="dash-row" style="align-items:flex-start">
                    <span class="dash-dot ok"></span>
                    <div style="flex:1">
                        <div>${CollectPage._esc(it.title)}</div>
                        <div class="dash-muted">${CollectPage._esc(it.account)}${it.publish_ts ? ' · ' + new Date(it.publish_ts * 1000).toLocaleDateString('zh-CN') : ''}</div>
                    </div>
                    <button class="btn btn-ghost btn-sm" onclick="CollectPage.collectHot('${CollectPage._escAttr(it.url)}')">采集原文</button>
                </div>`).join('')}`;
        } catch (e) {
            box.innerHTML = `<p class="dash-muted">查询失败：${CollectPage._esc(e.message || e)}（搜狗反爬较敏感，可稍后重试）</p>`;
        }
    },

    _esc(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    _escAttr(s) {
        // HTML 属性转义（非 URL 编码）：链接进入 href / onclick 单引号串
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
};
