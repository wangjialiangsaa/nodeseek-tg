const $ = selector => document.querySelector(selector);
let refreshTimer; let toastTimer;
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.className = `toast${error ? ' error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 6500); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'NodeSeek-TG', ...options.headers } });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/api/login') showLogin(); throw new Error(data.error || '请求失败'); }
  return data;
}
function showLogin() { clearInterval(refreshTimer); $('#dashboard').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#password').value = ''; }
function fillConfig(config) {
  const form = $('#config-form');
  for (const key of ['userId', 'chatId', 'userAgent', 'interval']) form.elements[key].value = config[key];
  form.elements.enabled.checked = config.enabled;
  for (const key of ['cookie', 'botToken', 'nsProxy', 'tgProxy']) {
    form.elements[key].value = '';
    const has = config[`has${key[0].toUpperCase()}${key.slice(1)}`];
    $(`#${key}-hint`).textContent = has ? '已加密保存。留空保留，需要更换时填入新值。' : '尚未配置。';
    form.elements[key].placeholder = has ? '已配置 · 不显示原值' : key.includes('Proxy') ? 'http://user:pass@IP:port' : key === 'cookie' ? '粘贴完整 Cookie 值' : '123456789:AA…';
  }
  form.elements.clearNsProxy.checked = false; form.elements.clearTgProxy.checked = false;
}
function formatTime(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
async function status() {
  const data = await api('/api/status');
  const enabled = data.enabled;
  const states = { idle: '等待首次检查', ok: '连接正常', auth: '登录已失效', blocked: '论坛验证 / 限流', network: '网络连接失败', format: '接口格式变化' };
  const el = $('#state'); el.textContent = !enabled ? '监控已暂停' : data.busy ? '正在检查…' : states[data.sourceState] || '等待配置';
  el.className = `pill${enabled && data.sourceState === 'ok' ? ' ok' : enabled && !['ok', 'idle'].includes(data.sourceState) ? ' warn' : ''}`;
  $('#last-check').textContent = data.lastCheck ? formatTime(data.lastCheck) : '尚未检查';
  $('#sent').textContent = `${data.sent} 条`; $('#pending').textContent = `${data.pending} 条`;
  const detail = $('#source-detail');
  detail.textContent = data.tgError || (!enabled ? '监控已暂停。开启后将继续检查并发送队列中的消息。' : data.detail || '首次连接只记录现有消息，后续检查才会转发新消息。');
  detail.className = `notice${data.tgError || ['auth', 'blocked', 'format', 'network'].includes(data.sourceState) ? ' error' : ''}`;
  const logs = $('#logs'); logs.replaceChildren();
  if (!data.logs.length) logs.textContent = '等待首次运行…';
  for (const entry of data.logs) {
    const row = document.createElement('div'); row.className = `log ${entry.level}`;
    const time = document.createElement('time'); time.textContent = formatTime(entry.time);
    const text = document.createElement('span'); text.textContent = entry.text;
    row.append(time, text); logs.append(row);
  }
}
async function showDashboard() {
  fillConfig(await api('/api/config'));
  $('#login').classList.add('hidden'); $('#dashboard').classList.remove('hidden');
  clearInterval(refreshTimer); await status();
  refreshTimer = setInterval(() => status().catch(() => {}), 5000);
}
async function busy(button, action) { button.disabled = true; try { await action(); } catch (e) { toast(e.message, true); } finally { button.disabled = false; } }
$('#login-form').addEventListener('submit', event => { event.preventDefault(); busy(event.submitter, async () => { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); $('#password').value = ''; await showDashboard(); }); });
$('#logout').addEventListener('click', () => busy($('#logout'), async () => { await api('/api/logout', { method: 'POST' }); showLogin(); }));
$('#config-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.submitter, async () => {
    const form = event.currentTarget || $('#config-form'); const data = {};
    for (const key of ['userId', 'chatId', 'userAgent', 'cookie', 'botToken', 'nsProxy', 'tgProxy']) data[key] = form.elements[key].value;
    data.interval = Number(form.elements.interval.value);
    for (const key of ['enabled', 'clearNsProxy', 'clearTgProxy']) data[key] = form.elements[key].checked;
    fillConfig(await api('/api/config', { method: 'PUT', body: JSON.stringify(data) }));
    toast('配置已保存'); await status();
  });
});
for (const [selector, path] of [['#test-telegram', '/api/test/telegram'], ['#test-nodeseek', '/api/test/nodeseek'], ['#check', '/api/check']]) {
  $(selector).addEventListener('click', () => busy($(selector), async () => { const data = await api(path, { method: 'POST' }); toast(data.message); await status(); }));
}
$('#password-form').addEventListener('submit', event => { event.preventDefault(); busy(event.submitter, async () => { const form = $('#password-form'); await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.elements.currentPassword.value, password: form.elements.password.value }) }); form.reset(); showLogin(); toast('密码已修改，请重新登录'); }); });
api('/api/session').then(data => data.authenticated ? showDashboard() : showLogin()).catch(() => { showLogin(); toast('无法连接服务，请刷新重试', true); });
