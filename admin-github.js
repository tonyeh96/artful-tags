/* Artful Tags — 纯前端 GitHub OAuth 管理后台（PKCE，无 secret）
 * 任意设备浏览器打开即登录，登录后直接读写仓库里的 artworks.json / mapping.json / 图片。
 * 安全：token 存 sessionStorage（关标签页即清）；权限仅 public_repo；退出可跳转 GitHub 撤销。
 */
(function () {
  'use strict';

  // ---------- 配置（持久化在 sessionStorage，方便换设备不改代码） ----------
  var DEFAULTS = {
    clientId: '',
    owner: 'tonyeh96',
    repo: 'artful-tags',
    branch: 'main',
    artworksPath: 'db/data/artworks.json',
    mappingPath: 'mapping.json',
    imagesDir: 'db/images'
  };

  function loadConfig() {
    try {
      var s = sessionStorage.getItem('gh_config');
      if (s) return Object.assign({}, DEFAULTS, JSON.parse(s));
    } catch (e) {}
    return Object.assign({}, DEFAULTS);
  }
  function saveConfig(c) {
    sessionStorage.setItem('gh_config', JSON.stringify(c));
  }
  var cfg = loadConfig();

  // ---------- 状态 ----------
  var token = sessionStorage.getItem('gh_token') || '';
  var user = null;
  var artworks = [];
  var artworksSha = null;
  var mapping = {};
  var mappingSha = null;
  var currentIndex = -1;

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k === 'html') e.innerHTML = props[k];
      else if (k.slice(0, 2) === 'on' && typeof props[k] === 'function') e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    }
    if (kids) kids.forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function b64urlEncode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64decodeUtf8(b64) { return decodeURIComponent(escape(atob(b64))); }
  function utf8ToB64(str) { return btoa(unescape(encodeURIComponent(str))); }

  function status(msg, kind) {
    var s = $('status');
    s.textContent = msg || '';
    s.className = 'status ' + (kind || '');
  }
  function apiBase() { return 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo; }
  function authHeaders(extra) {
    var h = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  // ---------- GitHub API ----------
  async function ghGet(path) {
    var res = await fetch(apiBase() + '/contents/' + path + '?ref=' + cfg.branch, { headers: authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('GET ' + path + ' → ' + res.status);
    return res.json();
  }
  async function ghPut(path, content, sha, message) {
    var body = { message: message, content: content };
    if (sha) body.sha = sha;
    var res = await fetch(apiBase() + '/contents/' + path, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      var t = '';
      try { t = (await res.json()).message; } catch (e) {}
      throw new Error('PUT ' + path + ' → ' + res.status + (t ? ' ' + t : ''));
    }
    return res.json();
  }
  async function uploadImage(file) {
    var name = file.name.replace(/\s+/g, '_').replace(/[^\w.\-]/g, '');
    var path = cfg.imagesDir + '/' + name;
    var existing = null;
    try { existing = await ghGet(path); } catch (e) {}
    var b64 = await new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result.split(',')[1]); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    var r = await ghPut(path, b64, existing ? existing.sha : null, 'admin: upload ' + name);
    return { name: name, sha: r.content.sha, url: 'https://raw.githubusercontent.com/' + cfg.owner + '/' + cfg.repo + '/' + cfg.branch + '/' + path };
  }

  // ---------- 数据加载 ----------
  async function loadData() {
    status('正在加载数据…');
    try {
      var a = await ghGet(cfg.artworksPath);
      artworks = a ? JSON.parse(b64decodeUtf8(a.content)) : [];
      if (!Array.isArray(artworks)) artworks = [];
      artworksSha = a ? a.sha : null;
      var m = await ghGet(cfg.mappingPath);
      mapping = m ? JSON.parse(b64decodeUtf8(m.content)) : {};
      if (typeof mapping !== 'object' || mapping === null) mapping = {};
      mappingSha = m ? m.sha : null;
      renderArtList();
      renderMapping();
      status('已加载 ' + artworks.length + ' 件作品 / ' + Object.keys(mapping).length + ' 条落地链接');
    } catch (e) {
      status('加载失败：' + e.message, 'err');
    }
  }

  // ---------- 作品列表 / 编辑器 ----------
  function renderArtList(filter) {
    var ul = $('artList');
    ul.innerHTML = '';
    filter = (filter || '').trim().toLowerCase();
    artworks.forEach(function (a, i) {
      var label = (a.leoNo || '?') + ' · ' + (a.title || '(无标题)');
      if (filter && (label + (a.series || '')).toLowerCase().indexOf(filter) < 0) return;
      var li = el('li', { class: i === currentIndex ? 'active' : '', onclick: function () { selectArt(i); } }, [label]);
      ul.appendChild(li);
    });
  }

  function blankArt() {
    var maxSerial = artworks.reduce(function (m, a) { return Math.max(m, a.serial || 0); }, 0);
    return {
      serial: maxSerial + 1, leoNo: '', flag: '', year: '', series: '', title: '',
      sizeInfo: '', description: '', extraInfo: '', collectionInfo: '', collectionRecord: '',
      mainImage: '', qrImage: '', otherImages: [], category: '', subtags: [], seriesRaw: ''
    };
  }

  function selectArt(i) {
    currentIndex = i;
    renderArtList($('artFilter').value);
    var a = artworks[i];
    var f = $('artForm');
    f.style.display = '';
    $('f_leoNo').value = a.leoNo || '';
    $('f_title').value = a.title || '';
    $('f_series').value = a.series || '';
    $('f_year').value = a.year || '';
    $('f_category').value = a.category || '';
    $('f_sizeInfo').value = a.sizeInfo || '';
    $('f_description').value = a.description || '';
    $('f_extraInfo').value = a.extraInfo || '';
    $('f_collectionInfo').value = a.collectionInfo || '';
    $('f_collectionRecord').value = a.collectionRecord || '';
    $('f_flag').value = a.flag || '';
    $('f_mainImage').value = a.mainImage || '';
    $('f_qrImage').value = a.qrImage || '';
    $('f_otherImages').value = (a.otherImages || []).join(', ');
    $('f_subtags').value = (a.subtags || []).join(', ');
    updatePreview();
  }

  function updatePreview() {
    var fn = $('f_mainImage').value.trim();
    var p = $('preview');
    if (fn) {
      var url = 'https://raw.githubusercontent.com/' + cfg.owner + '/' + cfg.repo + '/' + cfg.branch + '/' + cfg.imagesDir + '/' + fn;
      p.innerHTML = '<img src="' + esc(url) + '" alt="preview" onerror="this.parentNode.textContent=\'图片未找到\';">';
    } else { p.textContent = '（无主图）'; }
  }

  function collectArt() {
    var a = artworks[currentIndex];
    if (!a) return null;
    a.leoNo = $('f_leoNo').value.trim();
    a.title = $('f_title').value.trim();
    a.series = $('f_series').value.trim();
    a.year = $('f_year').value.trim();
    a.category = $('f_category').value.trim() || a.series;
    a.sizeInfo = $('f_sizeInfo').value;
    a.description = $('f_description').value;
    a.extraInfo = $('f_extraInfo').value;
    a.collectionInfo = $('f_collectionInfo').value;
    a.collectionRecord = $('f_collectionRecord').value;
    a.flag = $('f_flag').value.trim();
    a.mainImage = $('f_mainImage').value.trim();
    a.qrImage = $('f_qrImage').value.trim();
    a.otherImages = $('f_otherImages').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    a.subtags = $('f_subtags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return a;
  }

  async function saveArtworks() {
    if (currentIndex >= 0) collectArt();
    status('正在提交作品数据…');
    try {
      var content = utf8ToB64(JSON.stringify(artworks, null, 2));
      var r = await ghPut(cfg.artworksPath, content, artworksSha, 'admin: update artworks (' + artworks.length + ')');
      artworksSha = r.content.sha;
      renderArtList($('artFilter').value);
      status('作品已保存并推送到 GitHub ✓', 'ok');
    } catch (e) {
      if (e.message.indexOf('409') >= 0) status('冲突：数据已被别处修改，请点「重新加载」后再保存。', 'err');
      else status('保存失败：' + e.message, 'err');
    }
  }

  function addArt() {
    artworks.unshift(blankArt());
    currentIndex = 0;
    renderArtList($('artFilter').value);
    selectArt(0);
    status('已新增空白作品，填完点「保存作品」');
  }
  async function deleteArt() {
    if (currentIndex < 0) return;
    if (!confirm('确定删除当前作品「' + (artworks[currentIndex].title || artworks[currentIndex].leoNo) + '」？')) return;
    artworks.splice(currentIndex, 1);
    currentIndex = -1;
    $('artForm').style.display = 'none';
    renderArtList($('artFilter').value);
    await saveArtworks();
  }

  async function onImageUpload(kind) {
    var input = kind === 'main' ? $('imgMain') : $('imgQr');
    if (!input.files || !input.files[0]) return;
    status('上传图片中…');
    try {
      var r = await uploadImage(input.files[0]);
      if (kind === 'main') { $('f_mainImage').value = r.name; updatePreview(); }
      else { $('f_qrImage').value = r.name; }
      status('图片已上传：' + r.name + ' ✓', 'ok');
    } catch (e) {
      status('图片上传失败：' + e.message, 'err');
    }
  }

  // ---------- 落地链接 ----------
  function renderMapping() {
    var tb = $('mapTable');
    tb.innerHTML = '';
    Object.keys(mapping).sort().forEach(function (k) {
      var tr = el('tr', null, [
        el('td', null, [el('input', { class: 'k', value: k, onchange: function (e) { remapKey(k, e.target.value); } })]),
        el('td', null, [el('input', { class: 'v', value: mapping[k], onchange: function (e) { mapping[k] = e.target.value; } })]),
        el('td', null, [el('button', { class: 'del', text: '删除', onclick: function () { delete mapping[k]; renderMapping(); } })])
      ]);
      tb.appendChild(tr);
    });
  }
  function remapKey(oldK, newK) {
    newK = newK.trim();
    if (!newK || newK === oldK) return;
    if (mapping[newK] !== undefined) { alert('键 ' + newK + ' 已存在'); renderMapping(); return; }
    mapping[newK] = mapping[oldK];
    delete mapping[oldK];
  }
  function addMapRow() {
    var k = 'YJH-' + (prompt('新落地链接键（如 YJH-260403）', 'YJH-') || '').trim();
    if (!k) return;
    if (mapping[k] !== undefined) { alert('已存在'); return; }
    mapping[k] = 'https://tonyeh96.github.io/artful-tags/db/?art=' + k.replace('YJH-', '');
    renderMapping();
  }
  async function saveMapping() {
    status('正在提交落地链接…');
    try {
      var content = utf8ToB64(JSON.stringify(mapping, null, 2));
      var r = await ghPut(cfg.mappingPath, content, mappingSha, 'admin: update mapping (' + Object.keys(mapping).length + ')');
      mappingSha = r.content.sha;
      status('落地链接已保存 ✓', 'ok');
    } catch (e) {
      if (e.message.indexOf('409') >= 0) status('冲突：数据已被别处修改，请点「重新加载」后再保存。', 'err');
      else status('保存失败：' + e.message, 'err');
    }
  }

  // ---------- 登录（OAuth PKCE + Token 直登） ----------
  function redirectUri() { return location.origin + location.pathname; }

  // 注：GitHub 的 token 端点 github.com/login/oauth/access_token 不允许浏览器跨域（CORS）调用，
  // 纯前端无法走「授权码 + PKCE 换 token」。改用 implicit 流程（response_type=token）：
  // GitHub 直接在回跳 URL 的 #access_token=... 片段返回 token，不经过 token 端点，无 CORS 问题。
  async function oauthLogin() {
    if (!cfg.clientId) { alert('请先在「设置」里填写 GitHub OAuth App 的 Client ID'); return; }
    var state = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem('oauth_state', state);
    var url = 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(cfg.clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri()) +
      '&scope=' + encodeURIComponent('public_repo') +
      '&state=' + state + '&response_type=token';
    location.href = url;
  }

  function tokenLogin() {
    var t = $('tokenInput').value.trim();
    if (!t) { alert('请粘贴 GitHub Token'); return; }
    setToken(t);
  }

  function setToken(t) {
    token = t;
    sessionStorage.setItem('gh_token', t);
    sessionStorage.removeItem('pkce_verifier');
    sessionStorage.removeItem('oauth_state');
    history.replaceState(null, '', redirectUri());
    renderAuth();
    loadData();
  }

  async function fetchUser() {
    try {
      var res = await fetch('https://api.github.com/user', { headers: authHeaders() });
      if (res.ok) user = await res.json();
    } catch (e) {}
  }

  function logout() {
    sessionStorage.removeItem('gh_token');
    token = '';
    user = null;
    renderAuth();
    status('已退出（本浏览器钥匙已清除）。若在他人设备，请到 GitHub → Settings → Applications → Authorized OAuth Apps 撤销授权彻底作废。', 'warn');
  }

  function renderAuth() {
    var box = $('authBox');
    if (token) {
      box.innerHTML = '';
      box.appendChild(el('span', { class: 'who', text: '已登录：' + (user ? user.login : 'GitHub') }));
      box.appendChild(el('button', { class: 'btn', text: '退出登录', onclick: logout }));
      box.appendChild(el('a', { class: 'btn ghost', href: 'https://github.com/settings/applications', target: '_blank', text: 'GitHub 撤销授权' }));
    } else {
      box.innerHTML = '';
      box.appendChild(el('button', { class: 'btn primary', text: '用 GitHub 账号登录', onclick: oauthLogin }));
      box.appendChild(el('span', { class: 'hint', text: '或粘贴 Token：' }));
      box.appendChild(el('input', { id: 'tokenInput', placeholder: 'ghp_... / fine-grained', style: 'width:220px' }));
      box.appendChild(el('button', { class: 'btn', text: 'Token 登录', onclick: tokenLogin }));
    }
  }

  // ---------- 设置面板 ----------
  function renderSettings() {
    $('s_clientId').value = cfg.clientId;
    $('s_owner').value = cfg.owner;
    $('s_repo').value = cfg.repo;
    $('s_branch').value = cfg.branch;
    $('s_artworks').value = cfg.artworksPath;
    $('s_mapping').value = cfg.mappingPath;
    $('s_images').value = cfg.imagesDir;
    $('redirectUri').textContent = redirectUri();
  }
  function saveSettings() {
    cfg.clientId = $('s_clientId').value.trim();
    cfg.owner = $('s_owner').value.trim();
    cfg.repo = $('s_repo').value.trim();
    cfg.branch = $('s_branch').value.trim();
    cfg.artworksPath = $('s_artworks').value.trim();
    cfg.mappingPath = $('s_mapping').value.trim();
    cfg.imagesDir = $('s_images').value.trim();
    saveConfig(cfg);
    status('设置已保存（本设备 session 内有效）');
  }

  // ---------- 启动 ----------
  async function boot() {
    renderAuth();
    renderSettings();
    renderArtList();
    renderMapping();

    // 处理 OAuth 回跳（implicit 流程：token 在 URL 片段 #access_token=... 中）
    var hash = location.hash ? location.hash.replace(/^#/, '') : '';
    var hp = new URLSearchParams(hash);
    var t = hp.get('access_token');
    var retState = hp.get('state');
    if (t) {
      if (retState && retState !== sessionStorage.getItem('oauth_state')) {
        status('登录失败：state 不匹配，可能被伪造', 'err');
      } else {
        history.replaceState(null, '', redirectUri());
        setToken(t);
        await fetchUser();
      }
      return;
    }
    if (token) { await fetchUser(); loadData(); }
  }

  // 绑定静态按钮
  window.addEventListener('DOMContentLoaded', function () {
    $('saveCfg').addEventListener('click', saveSettings);
    $('reloadBtn').addEventListener('click', loadData);
    $('saveArt').addEventListener('click', saveArtworks);
    $('addArt').addEventListener('click', addArt);
    $('delArt').addEventListener('click', deleteArt);
    $('artFilter').addEventListener('input', function () { renderArtList(this.value); });
    $('imgMain').addEventListener('change', function () { onImageUpload('main'); });
    $('imgQr').addEventListener('change', function () { onImageUpload('qr'); });
    $('f_mainImage').addEventListener('input', updatePreview);
    $('addMap').addEventListener('click', addMapRow);
    $('saveMap').addEventListener('click', saveMapping);
    boot();
  });
})();
