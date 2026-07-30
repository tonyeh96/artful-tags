// cloudbase-auth.js —— 浏览器端 CloudBase 鉴权封装（原生手机号 + 微信）
// 依赖：<script src="https://imgcache.qq.com/qcloud/tcbjs/1.10.2/tcb.js"></script>（提供 window.cloudbase）
// 登录方式：手机号验证码 / 微信（控制台「登录授权」开启两种方式）
// 登录后由 gallery-auth 云函数建档并取角色（默认 viewer，首个用户=admin）
(function (global) {
  const ENV_ID = 'cloud1-d9gyg0egaa032c6cb';
  let app = null;
  let auth = null;
  let me = null; // { role, uid }

  async function init() {
    if (app) return app;
    app = global.cloudbase.init({ env: ENV_ID });
    auth = app.auth({ persistence: 'local' });
    try {
      const state = await auth.getLoginState();
      if (state && (state.customUserId || state.uid)) {
        me = await whoami();
      }
    } catch (e) {
      me = null;
    }
    return app;
  }

  // 登录成功后：建档 + 取角色
  async function afterLogin(extra) {
    const r = await app.callFunction({ name: 'gallery-auth', data: Object.assign({ action: 'ensureUser' }, extra || {}) });
    if (r.result && r.result.error) throw new Error(r.result.error);
    if (!r.result || !r.result.role) throw new Error('建档失败');
    me = { role: r.result.role, uid: r.result.uid, weixinBound: !!r.result.weixinBound };
    return me;
  }

  // 发送手机验证码
  async function sendSmsCode(phone) {
    await auth.sendPhoneSmsCode(phone);
  }

  // 手机号登录（已注册则登录，未注册则注册并登录）
  async function loginPhone(phone, code) {
    let state;
    try {
      state = await auth.signInWithPhone(phone, code);
    } catch (e) {
      state = await auth.signUpWithPhone(phone, code);
    }
    return await afterLogin({ phone });
  }

  // 微信登录
  async function loginWeixin() {
    await auth.signInWithWeixin();
    return await afterLogin();
  }

  // 绑定微信到当前账号（登录后调用，使同 uid 支持微信登录）
  async function linkWeixin() {
    await auth.currentUser.linkWithWeixin();
    const r = await app.callFunction({ name: 'gallery-auth', data: { action: 'ensureUser', weixinBound: true } });
    if (r.result && r.result.ok) me = { role: r.result.role, uid: r.result.uid };
    return me;
  }

  async function logout() {
    await auth.signOut();
    me = null;
  }

  async function whoami() {
    const r = await app.callFunction({ name: 'gallery-auth', data: { action: 'getRole' } });
    if (r.result && r.result.ok) return { role: r.result.role, uid: r.result.uid };
    return null;
  }

  // 调 gallery-admin（编辑类）
  async function callAdmin(action, payload) {
    if (!me) throw new Error('未登录');
    const res = await app.callFunction({ name: 'gallery-admin', data: { action, payload } });
    return res.result;
  }

  // 调 gallery-auth（账户/角色类：setRole / users:list）
  async function callAuth(action, data) {
    if (!me) throw new Error('未登录');
    const res = await app.callFunction({ name: 'gallery-auth', data: Object.assign({ action }, data || {}) });
    return res.result;
  }

  global.GalleryAuth = {
    init, sendSmsCode, loginPhone, loginWeixin, linkWeixin,
    logout, whoami, callAdmin, callAuth, getMe: () => me
  };
})(window);
