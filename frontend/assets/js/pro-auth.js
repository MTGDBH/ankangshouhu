(function () {
  'use strict';
  const page = document.body.dataset.authPage;
  const form = document.getElementById('auth-form');
  const errorBox = document.getElementById('auth-error');
  const submitButton = document.getElementById('submit-btn');
  const params = new URLSearchParams(location.search);
  const next = params.get('next');
  const requestedPage = next === '/family' || next === '/mobile' ? next : null;
  const switchLink = document.getElementById('switch-link');

  if (requestedPage) switchLink.search = new URLSearchParams({ next: requestedPage }).toString();
  if (page === 'register' && requestedPage === '/family') {
    form.elements.role.value = 'caregiver';
  }

  document.querySelectorAll('[data-toggle-password]').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.togglePassword);
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.textContent = visible ? '隐藏' : '显示';
      button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
    });
  });

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('show');
  }
  function destination(role) {
    const home = role === 'caregiver' || role === 'doctor' ? '/family' : '/mobile';
    return requestedPage === home ? requestedPage : home;
  }

  form.addEventListener('input', () => errorBox.classList.remove('show'));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    errorBox.classList.remove('show');
    const fields = new FormData(form);
    const password = String(fields.get('password') || '');
    let body;
    if (page === 'login') {
      const identifier = String(fields.get('identifier') || '').trim();
      if (!identifier || !password) return showError('请输入账号和密码');
      body = { identifier, password };
    } else {
      const name = String(fields.get('name') || '').trim();
      const ageText = String(fields.get('age') || '').trim();
      const age = ageText ? Number(ageText) : null;
      if (!name) return showError('请输入姓名');
      if (password.length < 6) return showError('密码至少 6 位');
      if (password !== fields.get('password2')) return showError('两次输入的密码不一致');
      if (ageText && (!Number.isInteger(age) || age < 1 || age > 120)) return showError('年龄请填写 1 至 120');
      body = { name, password, role: fields.get('role'), gender: fields.get('gender'), age };
    }
    const previousText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = page === 'login' ? '正在登录…' : '正在创建…';
    try {
      const result = await window.Pro.post(page === 'login' ? '/api/auth/login' : '/api/auth/register', body);
      location.replace(destination(result.user.role));
    } catch (error) {
      showError(error.message || (page === 'login' ? '登录失败' : '注册失败'));
      submitButton.disabled = false;
      submitButton.textContent = previousText;
    }
  });
})();
