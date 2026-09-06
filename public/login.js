document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('accessToken');
    if (token) {
        window.location.href = '/';
        return;
    }

    const loginForm = document.getElementById('loginForm');
    const alertBox = document.getElementById('loginAlert');
    const btn = document.getElementById('loginSubmit');

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;

        alertBox.className = 'alert';
        alertBox.textContent = '';
        btn.disabled = true;
        btn.textContent = 'Signing in...';

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await res.json();

            if (!res.ok) {
                alertBox.textContent = data.error || 'Login failed';
                alertBox.className = 'alert error';
            } else {
                localStorage.setItem('accessToken', data.accessToken);
                localStorage.setItem('apiToken', data.apiToken);
                localStorage.setItem('userRole', data.role);
                localStorage.setItem('username', data.username);
                window.location.href = '/';
            }
        } catch (err) {
            alertBox.textContent = 'Network error occurred. Please try again.';
            alertBox.className = 'alert error';
        } finally {
            btn.disabled = false;
            btn.textContent = 'Sign In';
        }
    });
});
