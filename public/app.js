document.addEventListener('DOMContentLoaded', () => {
    let token = localStorage.getItem('accessToken');
    if (!token) {
        window.location.href = '/login.html';
        return;
    }

    let apiToken = localStorage.getItem('apiToken') || '';
    const role = localStorage.getItem('userRole');
    const username = localStorage.getItem('username') || 'User';
    const isAdmin = role === 'admin';

    let keyVisible = false;
    let roomsCache = [];
    let reqsCache = [];
    let usersCache = [];
    let roomsRefreshTimer = null;
    let usageChartInstance = null;

    if (isAdmin) document.body.classList.add('is-admin');

    const toastContainer = document.getElementById('toastContainer');
    const roomsColspan = isAdmin ? 7 : 6;
    const reqsColspan = isAdmin ? 6 : 5;

    function showToast(message, type = 'info') {
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = message;
        toastContainer.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transition = 'opacity 0.2s ease';
            setTimeout(() => el.remove(), 200);
        }, 3200);
    }

    function formatNumber(n) {
        const num = Number(n);
        if (Number.isNaN(num)) return String(n ?? '—');
        return num.toLocaleString();
    }

    function maskKey(key) {
        if (!key) return 'N/A';
        if (key.length <= 12) return key;
        return `${key.substring(0, 8)}…${key.substring(key.length - 4)}`;
    }

    document.getElementById('greeting').textContent = `Welcome, ${username}`;
    document.getElementById('roleChip').textContent = role || 'user';

    if (isAdmin) {
        document.querySelectorAll('.admin-only').forEach(el => {
            el.classList.remove('admin-only');
            if (el.classList.contains('nav-link')) el.style.display = 'flex';
        });
    } else {
        document.querySelectorAll('.admin-only').forEach(el => el.remove());
    }

    function updateKeyDisplay() {
        const display = document.getElementById('apiKeyDisplay');
        if (!apiToken) {
            display.textContent = 'N/A';
            return;
        }
        display.textContent = keyVisible ? apiToken : maskKey(apiToken);
        display.title = keyVisible ? apiToken : 'Hidden API key';
    }
    updateKeyDisplay();

    document.getElementById('toggleKeyBtn').addEventListener('click', () => {
        keyVisible = !keyVisible;
        document.getElementById('toggleKeyBtn').textContent = keyVisible ? 'Hide' : 'Show';
        updateKeyDisplay();
    });

    document.getElementById('copyKeyBtn').addEventListener('click', async () => {
        if (!apiToken) return showToast('No API key available', 'error');
        try {
            await navigator.clipboard.writeText(apiToken);
            showToast('API key copied to clipboard', 'success');
        } catch {
            showToast('Failed to copy API key', 'error');
        }
    });

    document.getElementById('logoutBtn').addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.clear();
        window.location.href = '/login.html';
    });

    document.querySelectorAll('.code-block[data-copyable]').forEach(block => {
        const btn = block.querySelector('.copy-code-btn');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            const clone = block.cloneNode(true);
            clone.querySelectorAll('.copy-code-btn').forEach(b => b.remove());
            const text = clone.textContent.replace(/\n{3,}/g, '\n\n').trim();
            try {
                await navigator.clipboard.writeText(text);
                showToast('Code copied', 'success');
            } catch {
                showToast('Failed to copy', 'error');
            }
        });
    });

    async function apiFetch(endpoint, options = {}) {
        const res = await fetch(endpoint, {
            ...options,
            headers: {
                ...options.headers,
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        if (res.status === 401) {
            localStorage.clear();
            window.location.href = '/login.html';
        }
        return res;
    }

    // --- Navigation ---
    const navLinks = document.querySelectorAll('.nav-link[data-target]');
    const sections = document.querySelectorAll('.view-section');

    function clearRoomsAutoRefresh() {
        if (roomsRefreshTimer) {
            clearInterval(roomsRefreshTimer);
            roomsRefreshTimer = null;
        }
    }

    function startRoomsAutoRefresh() {
        clearRoomsAutoRefresh();
        roomsRefreshTimer = setInterval(() => loadRooms({ silent: true }), 10000);
    }

    function switchTab(target) {
        clearRoomsAutoRefresh();
        navLinks.forEach(link => link.classList.remove('active'));
        sections.forEach(sec => {
            sec.classList.remove('active');
            sec.style.display = 'none';
        });

        const activeLink = document.querySelector(`.nav-link[data-target="${target}"]`);
        const activeSection = document.getElementById(`view-${target}`);
        if (activeLink) activeLink.classList.add('active');
        if (activeSection) {
            activeSection.classList.add('active');
            activeSection.style.display = 'block';
        }

        loadData(target);
        if (target === 'rooms') startRoomsAutoRefresh();
        if (window.lucide) lucide.createIcons();
    }

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.hash = link.getAttribute('data-target');
        });
    });

    window.addEventListener('hashchange', () => {
        const hash = window.location.hash.replace('#', '') || 'dashboard';
        if (hash.startsWith('docs-')) return switchTab('docs');
        switchTab(hash);
    });

    async function loadData(target) {
        if (target === 'dashboard') loadStats();
        if (target === 'rooms') loadRooms();
        if (target === 'requests') loadRequests();
        if (target === 'account') loadAccount();
        if (target === 'users' && isAdmin) loadUsers();
    }

    // --- Dashboard ---
    async function loadStats() {
        try {
            const res = await apiFetch('/api/dashboard/stats');
            const data = await res.json();
            document.getElementById('stat-balance').textContent = formatNumber(data.balance);
            document.getElementById('stat-cost').textContent = formatNumber(data.cost_per_request);
            document.getElementById('stat-reqs').textContent = formatNumber(data.total_requests);
            document.getElementById('stat-total-cost').textContent = formatNumber(data.total_cost);

            const balanceCard = document.getElementById('stat-balance-card');
            const balance = Number(data.balance);
            const cost = Number(data.cost_per_request) || 1;
            balanceCard.classList.toggle('low-balance', balance < cost * 5);

            const chartRes = await apiFetch('/api/dashboard/chart-data');
            renderChart(await chartRes.json());
            if (window.lucide) lucide.createIcons();
        } catch (e) {
            console.error(e);
            showToast('Failed to load dashboard stats', 'error');
        }
    }

    function renderChart(data) {
        const labels = [];
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            labels.push(d.toISOString().split('T')[0]);
        }
        const reqMap = {};
        const roomMap = {};
        (data.requests || []).forEach(r => { reqMap[r.day] = r.count; });
        (data.rooms || []).forEach(r => { roomMap[r.day] = r.count; });

        const ctx = document.getElementById('usageChart').getContext('2d');
        if (usageChartInstance) usageChartInstance.destroy();
        usageChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'API Requests',
                        data: labels.map(day => reqMap[day] || 0),
                        borderColor: '#2563EB',
                        backgroundColor: 'rgba(37, 99, 235, 0.12)',
                        borderWidth: 2,
                        tension: 0.35,
                        fill: true,
                        pointRadius: 3,
                        pointBackgroundColor: '#2563EB'
                    },
                    {
                        label: 'Rooms Created',
                        data: labels.map(day => roomMap[day] || 0),
                        borderColor: '#D4AF37',
                        backgroundColor: 'rgba(212, 175, 55, 0.1)',
                        borderWidth: 2,
                        tension: 0.35,
                        fill: true,
                        pointRadius: 3,
                        pointBackgroundColor: '#D4AF37'
                    }
                ]
            },
            options: {
                responsive: true,
                plugins: { legend: { labels: { color: '#f4f4f5', boxWidth: 12 } } },
                scales: {
                    x: { ticks: { color: '#a1a1aa' }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: {
                        ticks: { color: '#a1a1aa', stepSize: 1 },
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        beginAtZero: true
                    }
                }
            }
        });
    }

    // --- Room drawer ---
    const drawer = document.getElementById('roomDrawer');
    const drawerOverlay = document.getElementById('drawerOverlay');

    function closeDrawer() {
        drawer.classList.remove('open');
        drawerOverlay.classList.remove('active');
        drawer.setAttribute('aria-hidden', 'true');
    }

    function openDrawer() {
        drawer.classList.add('open');
        drawerOverlay.classList.add('active');
        drawer.setAttribute('aria-hidden', 'false');
        if (window.lucide) lucide.createIcons();
    }

    document.getElementById('closeDrawerBtn').addEventListener('click', closeDrawer);
    drawerOverlay.addEventListener('click', closeDrawer);

    async function showRoomDetails(roomId) {
        document.getElementById('drawerTitle').textContent = `Room ${roomId}`;
        document.getElementById('drawerBody').innerHTML = '<p class="table-loading">Loading…</p>';
        document.getElementById('drawerActions').innerHTML = '';
        openDrawer();

        try {
            const res = await apiFetch(`/api/dashboard/rooms/${roomId}`);
            const room = await res.json();
            if (!res.ok) {
                document.getElementById('drawerBody').innerHTML = `<p>${room.error || 'Failed to load'}</p>`;
                return;
            }

            let players = [];
            try { players = JSON.parse(room.players || '[]'); } catch { players = []; }

            const state = (room.state || '').toLowerCase();
            const stateClass = state === 'waiting' ? 'status-waiting'
                : state === 'playing' ? 'status-playing' : 'status-finished';

            const playerHtml = players.length
                ? players.map(p => `
                    <span class="player-chip">
                        ${p.name || 'Player'} · ${p.color || '?'}
                        ${p.uid ? `<span class="mono">(${p.uid})</span>` : ''}
                        ${p.connected === false ? ' · offline' : ''}
                    </span>`).join('')
                : '<span class="detail-value">No players</span>';

            document.getElementById('drawerBody').innerHTML = `
                <div class="detail-grid">
                    <div class="detail-row">
                        <span class="detail-label">State</span>
                        <span class="detail-value"><span class="status-badge ${stateClass}">${room.state}</span></span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Type</span>
                        <span class="detail-value">${room.room_type || 'private'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Owner</span>
                        <span class="detail-value">${room.owner_username || ('#' + (room.user_id || '—'))}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Entry / Prize</span>
                        <span class="detail-value">${formatNumber(room.entry_fee || 0)} / ${formatNumber(room.winning_prize || 0)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Waiting time</span>
                        <span class="detail-value">${room.waiting_time || 60}s</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Callback URL</span>
                        <span class="detail-value mono">${room.callbackUrl || '—'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Created</span>
                        <span class="detail-value">${new Date(room.createdAt).toLocaleString()}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Live</span>
                        <span class="detail-value">${room.live
                            ? `${room.live.state} · ${room.live.connectedCount}/${room.live.playerCount} connected`
                            : 'Not in memory'}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Players</span>
                        <div>${playerHtml}</div>
                    </div>
                </div>`;

            const actions = document.getElementById('drawerActions');
            const canForceEnd = !['finished', 'cancelled'].includes(state);
            actions.innerHTML = `
                ${canForceEnd ? `<button type="button" class="btn-danger btn-sm" id="forceEndBtn">Force End + Webhook</button>` : ''}
                <button type="button" class="btn-secondary btn-sm" id="drawerDeleteBtn">Delete Room</button>
                <button type="button" class="btn-secondary btn-sm" id="drawerCloseBtn2">Close</button>`;

            document.getElementById('drawerCloseBtn2').addEventListener('click', closeDrawer);
            document.getElementById('drawerDeleteBtn').addEventListener('click', async () => {
                if (!confirm('Permanently delete this room without sending a webhook?')) return;
                const del = await apiFetch(`/api/dashboard/rooms/${roomId}`, { method: 'DELETE' });
                if (del.ok) {
                    showToast('Room deleted', 'success');
                    closeDrawer();
                    loadRooms();
                } else {
                    const d = await del.json();
                    showToast(d.error || 'Delete failed', 'error');
                }
            });
            document.getElementById('forceEndBtn')?.addEventListener('click', async () => {
                if (!confirm('Force-end this room and send a cancelled webhook?')) return;
                const fe = await apiFetch(`/api/dashboard/rooms/${roomId}/force-end`, {
                    method: 'POST',
                    body: JSON.stringify({ reason: 'operator force-ended' })
                });
                const d = await fe.json();
                if (fe.ok) {
                    showToast(d.webhookSent ? 'Room ended & webhook sent' : 'Room ended (no callback URL)', 'success');
                    showRoomDetails(roomId);
                    loadRooms();
                } else {
                    showToast(d.error || 'Force-end failed', 'error');
                }
            });
        } catch (e) {
            console.error(e);
            document.getElementById('drawerBody').innerHTML = '<p>Failed to load room details.</p>';
        }
    }

    // --- Rooms ---
    function renderRoomsTable() {
        const tbody = document.getElementById('roomsTableBody');
        const search = (document.getElementById('roomsSearch').value || '').trim().toLowerCase();
        const stateFilter = document.getElementById('roomsFilter').value;

        let rows = roomsCache.slice();
        if (stateFilter !== 'all') rows = rows.filter(r => (r.state || '').toLowerCase() === stateFilter);
        if (search) {
            rows = rows.filter(r =>
                String(r.roomId).toLowerCase().includes(search) ||
                String(r.owner_username || '').toLowerCase().includes(search)
            );
        }

        tbody.innerHTML = '';
        if (roomsCache.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${roomsColspan}"><div class="empty-state">
                <div class="empty-title">No rooms yet</div>
                <p>Rooms created via the API will appear here.</p>
                <button type="button" class="btn-secondary btn-sm" id="emptyRefreshRooms">Refresh</button>
            </div></td></tr>`;
            document.getElementById('emptyRefreshRooms')?.addEventListener('click', () => loadRooms());
            return;
        }
        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${roomsColspan}" class="table-loading">No rooms match your filters.</td></tr>`;
            return;
        }

        rows.forEach(room => {
            let playersCount = 0;
            try { playersCount = JSON.parse(room.players || '[]').length; } catch { playersCount = 0; }
            const state = (room.state || '').toLowerCase();
            const stateClass = state === 'waiting' ? 'status-waiting'
                : state === 'playing' ? 'status-playing' : 'status-finished';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code class="inline">${room.roomId}</code></td>
                <td><span class="status-badge ${stateClass}">${room.state}</span></td>
                <td>${room.room_type || 'private'}</td>
                <td>${playersCount} / 2</td>
                ${isAdmin ? `<td>${room.owner_username || '—'}</td>` : ''}
                <td>${new Date(room.createdAt).toLocaleString()}</td>
                <td class="cell-actions">
                    <button type="button" class="btn-secondary btn-sm view-room-btn" data-id="${room.roomId}">Details</button>
                    <button type="button" class="btn-danger btn-sm delete-room-btn" data-id="${room.roomId}">Delete</button>
                </td>`;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('.view-room-btn').forEach(btn => {
            btn.addEventListener('click', () => showRoomDetails(btn.dataset.id));
        });
        tbody.querySelectorAll('.delete-room-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this room? Prefer Force End from Details to notify webhooks.')) return;
                const res = await apiFetch(`/api/dashboard/rooms/${btn.dataset.id}`, { method: 'DELETE' });
                if (res.ok) {
                    showToast('Room deleted', 'success');
                    loadRooms();
                } else {
                    const data = await res.json();
                    showToast(data.error || 'Failed to delete room', 'error');
                }
            });
        });
    }

    async function loadRooms({ silent = false } = {}) {
        const btn = document.getElementById('refreshRoomsBtn');
        if (!silent) {
            btn.disabled = true;
            document.getElementById('roomsTableBody').innerHTML =
                `<tr><td colspan="${roomsColspan}" class="table-loading">Loading…</td></tr>`;
        }
        try {
            const res = await apiFetch('/api/dashboard/rooms');
            roomsCache = await res.json();
            if (!Array.isArray(roomsCache)) roomsCache = [];
            renderRoomsTable();
        } catch (e) {
            console.error(e);
            if (!silent) showToast('Failed to load rooms', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    document.getElementById('roomsSearch').addEventListener('input', renderRoomsTable);
    document.getElementById('roomsFilter').addEventListener('change', renderRoomsTable);
    document.getElementById('refreshRoomsBtn').addEventListener('click', () => loadRooms());

    // --- Requests ---
    function renderReqsTable() {
        const tbody = document.getElementById('reqsTableBody');
        const search = (document.getElementById('reqsSearch').value || '').trim().toLowerCase();
        const methodFilter = document.getElementById('reqsMethodFilter').value;
        let rows = reqsCache.slice();
        if (methodFilter !== 'all') rows = rows.filter(r => (r.method || '').toUpperCase() === methodFilter);
        if (search) {
            rows = rows.filter(r =>
                String(r.endpoint || '').toLowerCase().includes(search) ||
                String(r.owner_username || '').toLowerCase().includes(search)
            );
        }

        tbody.innerHTML = '';
        if (reqsCache.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${reqsColspan}"><div class="empty-state">
                <div class="empty-title">No API requests yet</div>
                <p>Billable API calls will show up in this log.</p>
                <button type="button" class="btn-secondary btn-sm" id="emptyRefreshReqs">Refresh</button>
            </div></td></tr>`;
            document.getElementById('emptyRefreshReqs')?.addEventListener('click', loadRequests);
            return;
        }
        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${reqsColspan}" class="table-loading">No requests match your filters.</td></tr>`;
            return;
        }

        rows.forEach(req => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${req.id}</td>
                <td>${req.endpoint}</td>
                <td><span class="status-badge status-waiting">${req.method}</span></td>
                <td style="color: var(--danger);">-${formatNumber(req.cost)}</td>
                ${isAdmin ? `<td>${req.owner_username || '—'}</td>` : ''}
                <td>${new Date(req.createdAt).toLocaleString()}</td>`;
            tbody.appendChild(tr);
        });
    }

    async function loadRequests() {
        const btn = document.getElementById('refreshReqsBtn');
        btn.disabled = true;
        document.getElementById('reqsTableBody').innerHTML =
            `<tr><td colspan="${reqsColspan}" class="table-loading">Loading…</td></tr>`;
        try {
            const res = await apiFetch('/api/dashboard/requests');
            reqsCache = await res.json();
            if (!Array.isArray(reqsCache)) reqsCache = [];
            renderReqsTable();
        } catch (e) {
            console.error(e);
            showToast('Failed to load requests', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    document.getElementById('reqsSearch').addEventListener('input', renderReqsTable);
    document.getElementById('reqsMethodFilter').addEventListener('change', renderReqsTable);
    document.getElementById('refreshReqsBtn').addEventListener('click', loadRequests);

    // --- Account ---
    async function loadAccount() {
        try {
            const res = await apiFetch('/api/account/me');
            const data = await res.json();
            if (!res.ok) return showToast(data.error || 'Failed to load account', 'error');
            document.getElementById('accountUsername').textContent = data.username;
            document.getElementById('accountRole').textContent = data.role;
            document.getElementById('accountBalance').textContent = formatNumber(data.balance);
            document.getElementById('accountCost').textContent = formatNumber(data.cost_per_request);
            if (data.api_token) {
                apiToken = data.api_token;
                localStorage.setItem('apiToken', apiToken);
                updateKeyDisplay();
            }
        } catch (e) {
            showToast('Failed to load account', 'error');
        }
    }

    document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPassword = document.getElementById('currentPassword').value;
        const newPassword = document.getElementById('newPasswordSelf').value;
        const res = await apiFetch('/api/account/change-password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Password updated', 'success');
            e.target.reset();
        } else {
            showToast(data.error || 'Failed to change password', 'error');
        }
    });

    document.getElementById('regenOwnKeyBtn').addEventListener('click', async () => {
        if (!confirm('Regenerate your API key? Clients using the old key will stop working.')) return;
        const res = await apiFetch('/api/account/regenerate-key', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            apiToken = data.apiToken;
            localStorage.setItem('apiToken', apiToken);
            keyVisible = true;
            document.getElementById('toggleKeyBtn').textContent = 'Hide';
            updateKeyDisplay();
            showToast('API key regenerated', 'success');
        } else {
            showToast(data.error || 'Failed to regenerate key', 'error');
        }
    });

    // --- Users (admin) ---
    function renderUsersTable() {
        const tbody = document.getElementById('usersTableBody');
        const search = (document.getElementById('usersSearch')?.value || '').trim().toLowerCase();
        let rows = usersCache.slice();
        if (search) rows = rows.filter(u => String(u.username).toLowerCase().includes(search));

        tbody.innerHTML = '';
        if (usersCache.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
                <div class="empty-title">No users found</div>
                <p>Create a user to get started.</p>
            </div></td></tr>`;
            return;
        }
        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="table-loading">No users match your search.</td></tr>`;
            return;
        }

        rows.forEach(user => {
            const enabled = user.enabled !== 0;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${user.id}</td>
                <td>${user.username}</td>
                <td><span class="role-chip">${user.role}</span></td>
                <td><span class="status-badge ${enabled ? 'status-enabled' : 'status-disabled'}">${enabled ? 'Active' : 'Disabled'}</span></td>
                <td>${formatNumber(user.balance)}</td>
                <td>${formatNumber(user.cost_per_request)}</td>
                <td>
                    <span class="mono" title="${user.api_token || ''}">${maskKey(user.api_token)}</span>
                    <button type="button" class="btn-secondary btn-sm copy-user-key" data-key="${user.api_token || ''}">Copy</button>
                </td>
                <td class="cell-actions">
                    <div class="btn-group">
                        <button type="button" class="btn-secondary btn-sm edit-btn"
                            data-id="${user.id}" data-balance="${user.balance}" data-cost="${user.cost_per_request}">Edit</button>
                        <button type="button" class="btn-secondary btn-sm topup-btn"
                            data-id="${user.id}" data-username="${user.username}">Top-up</button>
                        <button type="button" class="btn-secondary btn-sm reset-pw-btn"
                            data-id="${user.id}" data-username="${user.username}">Password</button>
                        <button type="button" class="btn-secondary btn-sm regen-key-btn" data-id="${user.id}">Regen Key</button>
                        <button type="button" class="btn-secondary btn-sm toggle-status-btn"
                            data-id="${user.id}" data-enabled="${enabled ? 1 : 0}">${enabled ? 'Disable' : 'Enable'}</button>
                        <button type="button" class="btn-danger btn-sm delete-user-btn" data-id="${user.id}">Delete</button>
                    </div>
                </td>`;
            tbody.appendChild(tr);
        });

        tbody.querySelectorAll('.copy-user-key').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!btn.dataset.key) return;
                try {
                    await navigator.clipboard.writeText(btn.dataset.key);
                    showToast('API key copied', 'success');
                } catch {
                    showToast('Copy failed', 'error');
                }
            });
        });

        tbody.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('editUserId').value = btn.dataset.id;
                document.getElementById('editBalance').value = btn.dataset.balance;
                document.getElementById('editCost').value = btn.dataset.cost;
                document.getElementById('editUserModal').classList.add('active');
            });
        });

        tbody.querySelectorAll('.topup-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('topUpUserId').value = btn.dataset.id;
                document.getElementById('topUpUsername').textContent = btn.dataset.username;
                document.getElementById('topUpAmount').value = '100';
                document.getElementById('topUpModal').classList.add('active');
            });
        });

        tbody.querySelectorAll('.reset-pw-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('resetPasswordUserId').value = btn.dataset.id;
                document.getElementById('resetPasswordUsername').textContent = btn.dataset.username;
                document.getElementById('resetNewPassword').value = '';
                document.getElementById('resetPasswordModal').classList.add('active');
            });
        });

        tbody.querySelectorAll('.regen-key-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Regenerate API key for this user?')) return;
                const res = await apiFetch(`/api/admin/users/${btn.dataset.id}/regenerate-key`, { method: 'POST' });
                const data = await res.json();
                if (res.ok) {
                    showToast('API key regenerated', 'success');
                    loadUsers();
                } else showToast(data.error || 'Failed', 'error');
            });
        });

        tbody.querySelectorAll('.toggle-status-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const currentlyEnabled = btn.dataset.enabled === '1';
                const next = currentlyEnabled ? 0 : 1;
                const res = await apiFetch(`/api/admin/users/${btn.dataset.id}/status`, {
                    method: 'PATCH',
                    body: JSON.stringify({ enabled: next })
                });
                const data = await res.json();
                if (res.ok) {
                    showToast(data.message || 'Status updated', 'success');
                    loadUsers();
                } else showToast(data.error || 'Failed', 'error');
            });
        });

        tbody.querySelectorAll('.delete-user-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this user?')) return;
                const res = await apiFetch(`/api/admin/users/${btn.dataset.id}`, { method: 'DELETE' });
                const data = await res.json();
                if (res.ok) {
                    showToast('User deleted', 'success');
                    loadUsers();
                } else showToast(data.error || 'Failed to delete user', 'error');
            });
        });
    }

    async function loadUsers() {
        try {
            document.getElementById('usersTableBody').innerHTML =
                '<tr><td colspan="8" class="table-loading">Loading…</td></tr>';
            const res = await apiFetch('/api/admin/users');
            usersCache = await res.json();
            if (!Array.isArray(usersCache)) usersCache = [];
            renderUsersTable();
        } catch (e) {
            console.error(e);
            showToast('Failed to load users', 'error');
        }
    }

    document.getElementById('usersSearch')?.addEventListener('input', renderUsersTable);

    document.querySelectorAll('.closeModal').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
        });
    });
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.classList.remove('active');
        });
    });

    if (isAdmin) {
        document.getElementById('addUserBtn')?.addEventListener('click', () => {
            document.getElementById('addUserModal').classList.add('active');
        });

        document.getElementById('addUserForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const body = {
                username: document.getElementById('newUsername').value.trim(),
                password: document.getElementById('newPasswordCreate').value,
                balance: Number(document.getElementById('newBalance').value),
                cost_per_request: Number(document.getElementById('newCost').value)
            };
            const res = await apiFetch('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
            const data = await res.json();
            if (res.ok) {
                document.getElementById('addUserModal').classList.remove('active');
                e.target.reset();
                document.getElementById('newBalance').value = '100';
                document.getElementById('newCost').value = '1';
                showToast(data.apiToken ? `User created. Key: ${maskKey(data.apiToken)}` : 'User created', 'success');
                if (data.apiToken) {
                    try { await navigator.clipboard.writeText(data.apiToken); } catch (_) {}
                }
                loadUsers();
            } else showToast(data.error || 'Failed to create user', 'error');
        });

        document.getElementById('editUserForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('editUserId').value;
            const body = {
                balance: Number(document.getElementById('editBalance').value),
                cost_per_request: Number(document.getElementById('editCost').value)
            };
            const res = await apiFetch(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
            if (res.ok) {
                document.getElementById('editUserModal').classList.remove('active');
                showToast('User updated', 'success');
                loadUsers();
            } else showToast('Failed to update user', 'error');
        });

        document.getElementById('topUpForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('topUpUserId').value;
            const amount = Number(document.getElementById('topUpAmount').value);
            const res = await apiFetch(`/api/admin/users/${id}/top-up`, {
                method: 'POST',
                body: JSON.stringify({ amount })
            });
            const data = await res.json();
            if (res.ok) {
                document.getElementById('topUpModal').classList.remove('active');
                showToast(`Balance is now ${formatNumber(data.balance)}`, 'success');
                loadUsers();
            } else showToast(data.error || 'Top-up failed', 'error');
        });

        document.getElementById('resetPasswordForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('resetPasswordUserId').value;
            const newPassword = document.getElementById('resetNewPassword').value;
            const res = await apiFetch(`/api/admin/users/${id}/reset-password`, {
                method: 'POST',
                body: JSON.stringify({ newPassword })
            });
            const data = await res.json();
            if (res.ok) {
                document.getElementById('resetPasswordModal').classList.remove('active');
                showToast('Password reset', 'success');
            } else showToast(data.error || 'Reset failed', 'error');
        });
    }

    // Mobile sidebar
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    function openSidebar() {
        sidebar.classList.add('open');
        sidebarOverlay.classList.add('active');
    }
    function closeSidebar() {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
    }
    document.getElementById('mobileMenuBtn').addEventListener('click', openSidebar);
    document.getElementById('closeSidebarBtn').addEventListener('click', closeSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 768) closeSidebar();
        });
    });

    const initialHash = window.location.hash.replace('#', '') || 'dashboard';
    const startTab = initialHash.startsWith('docs-') ? 'docs' : initialHash;
    switchTab(startTab);
    if (window.lucide) lucide.createIcons();
});
