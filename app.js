const PUSHER_KEY = '9916c0c7cc39de16616c';
const PUSHER_CLUSTER = 'ap2';

class TraceApp {
    constructor() {
        this.canvas = document.getElementById('trace-canvas');
        this.viewport = document.getElementById('canvas-viewport');
        this.ctx = this.canvas.getContext('2d', { alpha: true });

        // Settings
        this.isDrawing = false;
        this.currentColor = '#2d3436';
        this.currentSize = 8;
        this.fadeDuration = 24 * 60 * 60 * 1000; // 24 hours in ms

        // Identity
        this.user = this.loadIdentity();
        this.sessionSeed = Math.random().toString(36).substr(2, 9);

        // Data
        this.traces = [];
        this.localHistory = [];
        this.isPanMode = false;

        // Real-time synchronization (BroadcastChannel for tab-to-tab)
        this.syncChannel = new BroadcastChannel('trace_global_sync');

        // Theme (Default to Light)
        this.theme = localStorage.getItem('theme_v1') || 'light';
        document.body.setAttribute('data-theme', this.theme);

        // Admin State
        this.isAdmin = window.location.search.includes('admin=true') ||
            window.location.pathname.startsWith('/admin');
        this.isAuthenticated = false;
        this.adminPass = '';
        this.analytics = { visits: 0, clears: 0 };

        this.panOffset = {
            x: -window.innerWidth / 2,
            y: -window.innerHeight / 2
        };
        this.init();
        this.loadWorld();
        this.setCursor(this.currentColor);
        this.setupRealtime();

        // Fading update: Every minute
        setInterval(() => this.render(), 60000);
    }

    setupRealtime() {
        if (typeof Pusher === 'undefined') return;
        this.pusher = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER });
        this.channel = this.pusher.subscribe('trace-world');
        this.remoteCursors = new Map();
        this.presenceContainer = document.getElementById('remote-cursors-layer');

        this.channel.bind('undo-stroke', (data) => {
            console.log('Syncing undo globally...');
            this.traces = this.traces.filter(t => t.id !== data.id);
            this.render();
            this.updateStats();
        });

        this.channel.bind('cursor-move', (data) => {
            this.updateRemoteCursor(data);
        });

        this.channel.bind('new-stroke', (data) => {
            if (!this.traces.some(t => t.id === data.id)) {
                this.traces.push(data);
                this.render();
                this.updateStats();
            }
        });

        this.channel.bind('clear-world', () => {
            console.log('Global Clear Event Received');
            this.traces = [];
            this.localHistory = [];
            this.render();
            this.updateStats();
        });
    }

    async trackPresence() {
        if (this.user) {
            console.log('Realtime connected via Pusher');
        }
    }

    updateRemoteCursor(data) {
        if (!this.user || data.id === this.user.id) return;
        let cursor = this.remoteCursors.get(data.id);
        if (!cursor) {
            cursor = document.createElement('div');
            cursor.className = 'remote-cursor';
            cursor.innerHTML = `
                <svg class="ghost-crayon" style="fill:${data.color}" viewBox="0 0 32 32">
                    <path d="M16 2 L4 22 L12 22 L11 30 L21 30 L20 22 L28 22 Z" stroke="black" stroke-width="1"/>
                </svg>
                <div class="cursor-label">
                    <div class="cursor-avatar"><img src="${data.avatar}" style="width:100%"></div>
                    <span>${data.nickname}</span>
                </div>
            `;
            this.presenceContainer.appendChild(cursor);
            this.remoteCursors.set(data.id, cursor);
        }
        cursor.style.transform = `translate(${data.pos.x - this.panOffset.x}px, ${data.pos.y - this.panOffset.y}px)`;
    }

    init() {
        this.resize();
        window.addEventListener('resize', () => this.resize());

        // Identity Modal
        const modal = document.getElementById('identity-modal');
        if (this.isAdmin) {
            modal.classList.add('hidden');
        } else {
            const savedUser = this.loadIdentity();
            if (savedUser && savedUser.nickname && savedUser.password && savedUser.password.length >= 4) {
                this.user = savedUser;
                modal.classList.add('hidden');
                this.updateIdentityDisplay();
                this.setupRealtime();
                this.trackPresence();
            } else {
                this.sessionSeed = Math.random().toString(36).substr(2, 9);
                modal.classList.remove('hidden');
            }
        }

        // Admin Flow (UI Modal)
        if (this.isAdmin) {
            const adminModal = document.getElementById('admin-modal');
            adminModal.classList.remove('hidden');

            document.getElementById('admin-login-btn').onclick = async () => {
                const pass = document.getElementById('admin-password-input').value;
                try {
                    const res = await fetch('/api/admin-auth', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: pass })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        this.isAuthenticated = true;
                        this.adminPass = pass;
                        adminModal.classList.add('hidden');
                        document.body.classList.add('is-admin');
                        this.showAdminPanel();
                        console.info('Admin: Authenticated.');
                    } else {
                        throw new Error(data.error);
                    }
                } catch (e) {
                    const error = document.getElementById('admin-login-error');
                    error.innerText = e.message || 'incorrect passphrase.';
                    error.style.opacity = '1';
                    setTimeout(() => error.style.opacity = '0', 3000);
                }
            };
        }

        document.getElementById('save-identity').addEventListener('click', () => this.saveIdentity());
        const nicknameInput = document.getElementById('nickname-input');
        const userPassInput = document.getElementById('user-password-input');

        [nicknameInput, userPassInput].forEach(inp => {
            if (inp) {
                inp.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') this.saveIdentity();
                });
            }
        });

        if (nicknameInput) {
            nicknameInput.addEventListener('input', (e) => {
                this.updateSetupPreview(e.target.value);
            });
        }

        // Hiding instruments for admin
        if (this.isAdmin) {
            const overlay = document.getElementById('interface-overlay');
            if (overlay) overlay.style.display = 'none';
        }

        // Toolbar Tool Listeners
        const undoBtn = document.getElementById('undo-btn');
        if (undoBtn) undoBtn.onclick = () => this.undo();

        const centerBtn = document.getElementById('center-btn');
        if (centerBtn) {
            centerBtn.onclick = () => {
                this.panOffset = {
                    x: -window.innerWidth / 2,
                    y: -window.innerHeight / 2
                };
                this.render();
            };
        }

        const panBtn = document.getElementById('pan-btn');
        if (panBtn) {
            panBtn.onclick = () => {
                this.isPanMode = !this.isPanMode;
                panBtn.classList.toggle('active', this.isPanMode);
                this.setCursor(this.isPanMode ? 'pan' : this.currentColor);
            };
        }

        // Initial Active States
        const obsidian = document.querySelector('.color-btn[data-color="#2d3436"]');
        if (obsidian) obsidian.click();

        const sizeSlider = document.getElementById('size-slider');
        const sizeHint = document.getElementById('current-size-hint');
        if (sizeSlider) {
            sizeSlider.oninput = (e) => {
                this.currentSize = parseInt(e.target.value);
                if (sizeHint) sizeHint.innerText = this.currentSize;
            };
        }

        // Color buttons
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentColor = btn.dataset.color;
                this.setCursor(this.currentColor);
            });
        });

        // Input listeners
        this.canvas.addEventListener('mousedown', (e) => this.startDrawing(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.stopDrawing());

        // Touch support
        this.canvas.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            this.startDrawing({ clientX: touch.clientX, clientY: touch.clientY });
        });
        this.canvas.addEventListener('touchmove', (e) => {
            if (e.touches.length > 1) return;
            e.preventDefault();
            const touch = e.touches[0];
            this.handleMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
        }, { passive: false });
        this.canvas.addEventListener('touchend', () => this.stopDrawing());

        // Keyboard (Undo)
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                this.undo();
            }
        });

        // Reset button
        const resetBtn = document.getElementById('reset-btn');
        if (resetBtn) resetBtn.addEventListener('click', () => this.clearAll());

        // Theme toggle
        const themeToggle = document.getElementById('theme-toggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                this.theme = this.theme === 'light' ? 'dark' : 'light';
                document.body.setAttribute('data-theme', this.theme);
                localStorage.setItem('theme_v1', this.theme);
                this.render();
            });
        }

        // Local sync channel listener
        this.syncChannel.onmessage = (event) => {
            const { type, payload } = event.data;
            if (type === 'NEW_TRACE') {
                if (!this.traces.some(t => t.id === payload.id)) {
                    this.traces.push(payload);
                    this.render();
                    this.updateStats();
                }
            } else if (type === 'UNDO') {
                this.traces = this.traces.filter(t => t.id !== payload.id);
                this.render();
                this.updateStats();
            } else if (type === 'CLEAR_WORLD') {
                this.traces = [];
                this.render();
                this.updateStats();
            }
        };

        this.updateStats();
    }

    setCursor(type) {
        if (type === 'pan') {
            document.body.style.cursor = 'grab';
            return;
        }
        const color = type;
        const colorPlain = color.replace('#', '');
        const svg = `
        <svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>
            <defs>
                <filter id='crayonTexture'>
                    <feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' seed='1' result='noise'/>
                    <feDisplacementMap in='SourceGraphic' in2='noise' scale='1.5' xChannelSelector='R' yChannelSelector='G'/>
                </filter>
            </defs>
            <g filter='url(%23crayonTexture)'>
                <path d='M16 2 L4 22 L11 30 L21 30 L20 22 L28 22 Z' fill='%23${colorPlain}' stroke='black' stroke-width='1.5' stroke-linejoin='round'/>
            </g>
        </svg>`.replace(/\n/g, '').replace(/\s+/g, ' ');

        const url = `data:image/svg+xml;utf8,${svg}`;
        document.body.style.cursor = `url("${url}") 16 2, crosshair`;
    }

    setCookie(name, value) {
        const d = new Date();
        d.setTime(d.getTime() + (365 * 24 * 60 * 60 * 1000));
        const expires = "expires=" + d.toUTCString();
        document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; ${expires}; path=/; SameSite=Lax`;
    }

    getCookie(name) {
        const nameEQ = name + "=";
        const ca = document.cookie.split(';');
        for (let i = 0; i < ca.length; i++) {
            let c = ca[i];
            while (c.charAt(0) === ' ') c = c.substring(1, c.length);
            if (c.indexOf(nameEQ) === 0) {
                try {
                    return JSON.parse(decodeURIComponent(c.substring(nameEQ.length, c.length)));
                } catch (e) {
                    console.error("Error parsing cookie:", e);
                    return null;
                }
            }
        }
        return null;
    }

    getAvatarUrl(seed) {
        return `https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(seed)}`;
    }

    updateSetupPreview(nick) {
        const seed = nick.trim() + (this.sessionSeed || 'init');
        const previewEl = document.getElementById('setup-avatar-preview');
        if (previewEl) this.renderAvatar(previewEl, this.getAvatarUrl(seed));
    }

    async saveIdentity() {
        const nickInput = document.getElementById('nickname-input');
        const passInput = document.getElementById('user-password-input');
        const nick = nickInput.value.trim();
        const pass = passInput.value.trim();

        if (nick.length < 2 || pass.length < 4) {
            alert('please enter both nickname and password (min 4 chars).');
            return;
        }

        try {
            const res = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nickname: nick, password: pass })
            });

            const data = await res.json();
            if (!res.ok) {
                alert(data.error || 'auth failed');
                return;
            }

            this.user = {
                ...data.user,
                avatar: this.getAvatarUrl(nick + this.sessionSeed)
            };
        } catch (e) {
            alert('auth error');
            return;
        }

        this.setCookie('trace_user_cookie', this.user);
        localStorage.setItem('trace_user_v2', JSON.stringify(this.user));

        document.getElementById('identity-modal').classList.add('hidden');
        this.updateIdentityDisplay();
        this.setupRealtime();
        this.trackPresence();
    }

    loadIdentity() {
        try {
            const KEY = 'trace_user_v2';
            let saved = localStorage.getItem(KEY);
            if (saved && saved !== "undefined" && saved !== "null") {
                const user = JSON.parse(saved);
                if (user && user.id) return user;
            }

            const cookieUser = this.getCookie('trace_user_cookie');
            if (cookieUser && cookieUser.id) {
                localStorage.setItem(KEY, JSON.stringify(cookieUser));
                return cookieUser;
            }
            return null;
        } catch (e) {
            localStorage.removeItem('trace_user_v2');
            return null;
        }
    }

    updateIdentityDisplay() {
        const nickEl = document.getElementById('current-user-nickname');
        const avatarEl = document.getElementById('current-user-avatar');
        if (nickEl) nickEl.innerText = this.user.nickname;
        if (avatarEl) this.renderAvatar(avatarEl, this.user.avatar);
    }

    renderAvatar(container, avatarUrl) {
        if (typeof avatarUrl !== 'string') {
            container.innerHTML = `<div style="width:100%;height:100%;background:#ccc;border-radius:50%"></div>`;
            return;
        }
        container.innerHTML = `<img src="${avatarUrl}" alt="avatar">`;
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.render();
    }

    getCoord(e) {
        const rect = this.canvas.getBoundingClientRect();
        // Robust coordinate mapping: Calculate actual scale between CSS pixels and Canvas resolution
        const scaleX = rect.width / this.canvas.width;
        const scaleY = rect.height / this.canvas.height;

        const x = (e.clientX - rect.left) / scaleX;
        const y = (e.clientY - rect.top) / scaleY;
        return { x: x + this.panOffset.x, y: y + this.panOffset.y };
    }

    startDrawing(e) {
        if (!this.user || this.isAdmin) return;

        if (this.isPanMode) {
            this.isPanning = true;
            this.lastPan = { x: e.clientX, y: e.clientY };
            document.body.style.cursor = 'grabbing';
            return;
        }

        this.isDrawing = true;
        const pos = this.getCoord(e);
        this.currentStroke = {
            id: Math.random().toString(36).substr(2, 9),
            userId: this.user.id,
            nickname: this.user.nickname,
            avatar: this.user.avatar,
            color: this.currentColor,
            size: this.currentSize,
            timestamp: Date.now(),
            points: [pos]
        };
        this.traces.push(this.currentStroke);
        this.localHistory.push(this.currentStroke.id);
        this.updateStats();
        this.syncChannel.postMessage({ type: 'NEW_TRACE', payload: this.currentStroke });
    }

    handleMouseMove(e) {
        if (this.isPanning) {
            const dx = (e.clientX - this.lastPan.x);
            const dy = (e.clientY - this.lastPan.y);
            this.panOffset.x -= dx;
            this.panOffset.y -= dy;
            this.lastPan = { x: e.clientX, y: e.clientY };
            this.render();
            return;
        }

        const pos = this.getCoord(e);

        if (this.user) {
            const now = Date.now();
            if (!this.lastBroadcast || now - this.lastBroadcast > 50) {
                this.lastBroadcast = now;
                fetch('/api/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        event: 'cursor-move',
                        payload: {
                            id: this.user.id,
                            nickname: this.user.nickname,
                            avatar: this.user.avatar,
                            color: this.currentColor,
                            pos: pos
                        }
                    })
                }).catch(() => { });
            }
        }

        if (this.isDrawing) {
            const lastPoint = this.currentStroke.points[this.currentStroke.points.length - 1];
            const dist = Math.hypot(pos.x - lastPoint.x, pos.y - lastPoint.y);
            if (dist > 3) {
                this.currentStroke.points.push(pos);
                this.drawSegment(lastPoint, pos, this.currentColor, this.currentSize);
            }
        } else {
            if (window.matchMedia('(hover: hover)').matches) {
                this.checkHover(e);
            }
        }
    }

    stopDrawing() {
        if (this.isPanning) {
            this.isPanning = false;
            document.body.style.cursor = 'grab';
            return;
        }
        if (!this.isDrawing) return;
        this.isDrawing = false;
        if (this.currentStroke) {
            const stroke = this.currentStroke;
            fetch('/api/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'new-stroke', payload: stroke })
            }).catch(() => { });

            fetch('/api/traces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(stroke)
            }).catch(e => console.error('Cloud save failed:', e));
        }
    }

    async undo() {
        if (this.localHistory.length === 0) return;
        const lastId = this.localHistory.pop();
        this.traces = this.traces.filter(t => t.id !== lastId);

        // Broadcast locally
        this.syncChannel.postMessage({ type: 'UNDO', payload: { id: lastId } });

        // Broadcast globally via Pusher
        fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'undo-stroke', payload: { id: lastId } })
        }).catch(() => { });

        // Persistent removal
        fetch('/api/traces', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: lastId })
        }).catch(e => console.error('Cloud undo failed:', e));

        this.render();
        this.updateStats();
    }

    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const now = Date.now();
        this.traces = this.traces.filter(t => (now - t.timestamp) < this.fadeDuration);

        // Make the background move to create the infinite canvas sensation
        document.body.style.backgroundPosition = `${-this.panOffset.x}px ${-this.panOffset.y}px`;

        this.ctx.save();
        this.ctx.translate(-this.panOffset.x, -this.panOffset.y);

        this.traces.forEach(stroke => {
            const elapsed = now - stroke.timestamp;
            const fadeAlpha = Math.max(0, 1 - (elapsed / this.fadeDuration));
            this.ctx.globalAlpha = fadeAlpha;
            this.drawFullStroke(stroke);
        });

        this.ctx.restore();
        this.ctx.globalAlpha = 1.0;
    }

    drawFullStroke(stroke) {
        for (let i = 1; i < stroke.points.length; i++) {
            this.drawSegment(stroke.points[i - 1], stroke.points[i], stroke.color, stroke.size);
        }
    }

    drawSegment(p1, p2, color, size) {
        this.ctx.fillStyle = color;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);

        for (let d = 0; d < dist; d += 2) {
            const px = p1.x + Math.cos(angle) * d;
            const py = p1.y + Math.sin(angle) * d;
            for (let j = 0; j < 4; j++) {
                const rx = (Math.random() - 0.5) * size;
                const ry = (Math.random() - 0.5) * size;
                this.ctx.beginPath();
                this.ctx.arc(px + rx, py + ry, Math.random() * 1.5 + 0.5, 0, Math.PI * 2);
                this.ctx.fill();
            }
        }
    }

    checkHover(e) {
        const tooltip = document.getElementById('trace-tooltip');
        let found = null;
        const pos = this.getCoord(e);

        for (let i = this.traces.length - 1; i >= 0; i--) {
            const stroke = this.traces[i];
            for (let j = 0; j < stroke.points.length; j += 10) {
                const p = stroke.points[j];
                if (Math.hypot(pos.x - p.x, pos.y - p.y) < 15) {
                    found = stroke;
                    break;
                }
            }
            if (found) break;
        }

        if (found) {
            tooltip.classList.remove('hidden');
            tooltip.style.left = (e.clientX + 15) + 'px';
            tooltip.style.top = (e.clientY + 15) + 'px';
            document.getElementById('tooltip-nickname').innerText = found.nickname;
            this.renderAvatar(document.getElementById('tooltip-avatar'), found.avatar);
        } else {
            tooltip.classList.add('hidden');
        }
    }

    async loadWorld() {
        try {
            const res = await fetch('/api/traces');
            const data = await res.json();
            const existingIds = new Set(this.traces.map(t => t.id));
            const newGlobalTraces = data.traces.filter(t => !existingIds.has(t.id));

            if (newGlobalTraces.length > 0) {
                this.traces = [...this.traces, ...newGlobalTraces];
                this.render();
            }

            this.analytics = data.analytics || { visits: 0, clears: 0 };
            this.updateStats();
        } catch (e) {
            console.error('World load failed:', e);
        }
    }

    async trackVisit() {
        fetch('/api/visits', { method: 'POST' }).catch(() => { });
    }

    async clearAll() {
        if (!this.isAuthenticated) return;
        if (confirm('this will clear all traces GLOBALLY. proceed?')) {
            try {
                const res = await fetch('/api/traces', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: this.adminPass })
                });

                if (res.ok) {
                    this.traces = [];
                    this.localHistory = [];
                    this.render();
                    this.updateStats();

                    // Global sync via Pusher
                    fetch('/api/sync', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ event: 'clear-world', payload: {} })
                    }).catch(() => { });

                    this.syncChannel.postMessage({ type: 'CLEAR_WORLD' });
                } else {
                    alert('clear failed.');
                }
            } catch (e) {
                console.error('Clear failed:', e);
            }
        }
    }

    showAdminPanel() {
        const statsEl = document.querySelector('.stats');
        const footer = document.querySelector('footer');
        if (footer) footer.classList.add('admin-view');

        const contributors = [...new Set(this.traces.map(t => t.nickname))];
        const latestContributor = contributors.length > 0 ? contributors[contributors.length - 1] : 'none';

        if (statsEl) {
            statsEl.innerHTML = `
                <div class="admin-dashboard">
                    <div class="stat-group">
                        <span class="stat-label">total visits:</span> ${this.analytics.visits}
                    </div>
                    <div class="stat-group">
                        <span class="stat-label">total clears:</span> ${this.analytics.clears}
                    </div>
                    <div class="stat-group">
                        <span class="stat-label">active traces:</span> ${this.traces.length}
                    </div>
                    <div class="stat-group">
                        <span class="stat-label">contributors:</span> ${contributors.length}
                    </div>
                    <div class="stat-group">
                        <span class="stat-label">latest:</span> ${latestContributor}
                    </div>
                </div>
            `;
        }
    }

    updateStats() {
        const count = document.getElementById('trace-count');
        if (count) count.innerText = this.traces.length;
        if (this.isAuthenticated) {
            this.showAdminPanel();
        }
    }
}

window.onload = async () => {
    const app = new TraceApp();
    await app.trackVisit();
};
