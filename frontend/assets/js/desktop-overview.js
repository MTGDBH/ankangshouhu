document.addEventListener('auth:ready', ({ detail: user }) => {
  const host = document.getElementById('health-home');
  const endpoints = {
    summary: '/api/health/summary', metrics: '/api/health/metrics',
    todos: '/api/todos/today', alerts: '/api/alerts?status=pending',
  };
  const data = {};

  async function refresh(sections) {
    host.setAttribute('aria-busy', 'true');
    await Promise.all(sections.map(async key => {
      try {
        const result = await API.get(endpoints[key]);
        data[key] = key === 'alerts' ? result.items : result;
      } catch {
        data[key] = null;
      }
    }));
    HealthOverview.render(host, user, data);
    host.setAttribute('aria-busy', 'false');
  }

  host.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const { homeRetry, homeTodo, homeCompleted } = button.dataset;
    if (homeRetry) {
      button.disabled = true;
      await refresh([homeRetry]);
    } else if (homeTodo) {
      button.disabled = true;
      try {
        await API.patch(`/api/todos/${homeTodo}`, { completed: homeCompleted !== '1' });
        await refresh(['todos', 'summary']);
        host.querySelector(`[data-home-todo="${homeTodo}"]`)?.focus();
        toast(homeCompleted === '1' ? '已撤销完成' : '任务已完成', 'success');
      } catch (error) {
        button.disabled = false;
        toast(error.message || '任务暂时无法更新，请重试。', 'error');
      }
    }
  });

  refresh(Object.keys(endpoints));
  WeatherWidget.init();
});
Auth.init();
