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
        this.user = this.loadIdentity() || null;

        // Data
        this.traces = [];
        this.localHistory = [];

        // Real-time synchronization (BroadcastChannel for tab-to-tab)
        this.syncChannel = new BroadcastChannel('trace_global_sync');

        // Theme (Default to Dark)
        this.theme = localStorage.getItem('theme_v1') || 'dark';
        document.body.setAttribute('data-theme', this.theme);

        // Admin State
        this.isAdmin = window.location.search.includes('admin=true');
        this.isAuthenticated = false;
        this.adminPass = '';
        this.analytics = { visits: 0, clears: 0 };

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
    }

    async trackPresence() {
        // Pusher client events or simply notifying others
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
        cursor.style.transform = `translate(${data.pos.x}px, ${data.pos.y}px)`;
    }

    init() {
        this.resize();
        window.addEventListener('resize', () => this.resize());

        // Identity Modal
        if (!this.user) {
            this.sessionSeed = Math.random().toString(36).substr(2, 9);
            document.getElementById('identity-modal').classList.remove('hidden');
            this.updateSetupPreview('');
        } else {
            this.updateIdentityDisplay();
        }

        // Admin Auth Flow
        if (this.isAdmin) {
            setTimeout(() => {
                this.adminPass = prompt('enter administrator password:');
                if (this.adminPass === '1234') {
                    this.isAuthenticated = true;
                    document.body.classList.add('is-admin');
                    this.showAdminPanel();
                } else {
                    alert('access denied.');
                    window.location.href = window.location.pathname;
                }
            }, 100);
        }

        document.getElementById('save-identity').addEventListener('click', () => this.saveIdentity());

        const nicknameInput = document.getElementById('nickname-input');
        nicknameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.saveIdentity();
        });

        nicknameInput.addEventListener('input', (e) => {
            this.updateSetupPreview(e.target.value);
        });

        // Hiding instruments for admin
        if (this.isAdmin) {
            const overlay = document.getElementById('interface-overlay');
            if (overlay) overlay.style.display = 'none';
        }

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
            if (e.touches.length > 1) return; // Allow two-finger scroll
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

        // Color buttons
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentColor = btn.dataset.color;
                this.setCursor(this.currentColor);
            });
        });

        // Size slider
        document.getElementById('size-slider').addEventListener('input', (e) => {
            this.currentSize = parseInt(e.target.value);
        });

        // Reset button
        document.getElementById('reset-btn').addEventListener('click', () => this.clearAll());

        // Theme toggle
        document.getElementById('theme-toggle').addEventListener('click', () => {
            this.theme = this.theme === 'light' ? 'dark' : 'light';
            document.body.setAttribute('data-theme', this.theme);
            localStorage.setItem('theme_v1', this.theme);
            this.render();
        });

        // Real-time listener
        this.syncChannel.onmessage = (event) => {
            const { type, payload } = event.data;
            if (type === 'NEW_TRACE') {
                this.traces.push(payload);
                this.render();
                this.updateStats();
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

    setCursor(color) {
        // Crayon texture using FE Turbulence
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
                <path d='M16 2 L4 22 L12 22 L11 30 L21 30 L20 22 L28 22 Z' fill='%23${colorPlain}' stroke='black' stroke-width='1.5' stroke-linejoin='round'/>
                <!-- Subtle waxy highlights -->
                <path d='M10 22 L16 8 M14 23 L19 10' stroke='rgba(255,255,255,0.2)' stroke-width='1.5' stroke-linecap='round'/>
            </g>
        </svg>`.replace(/\n/g, '').replace(/\s+/g, ' ');

        const url = `data:image/svg+xml;utf8,${svg}`;
        document.body.style.cursor = `url("${url}") 16 2, crosshair`;
    }

    setCookie(name, value) {
        const d = new Date();
        d.setTime(d.getTime() + (365 * 24 * 60 * 60 * 1000));
        const expires = "expires=" + d.toUTCString();
        // Ensure path / so it's global for the site
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

    // --- Identity ---

    getAvatarUrl(seed) {
        // Pixel-art style with some waxy colors. Consistent seed.
        return `https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(seed)}`;
    }

    updateSetupPreview(nick) {
        // Mix the session seed with the nickname so even 'anonymous' looks random per user
        const seed = nick.trim() + (this.sessionSeed || 'init');
        const previewEl = document.getElementById('setup-avatar-preview');
        if (previewEl) this.renderAvatar(previewEl, this.getAvatarUrl(seed));
    }

    saveIdentity() {
        const input = document.getElementById('nickname-input');
        const nick = input.value.trim() || 'anonymous';
        const seed = nick + (this.sessionSeed || Math.random());

        this.user = {
            id: Math.random().toString(36).substr(2, 9),
            nickname: nick,
            avatar: this.getAvatarUrl(seed)
        };

        this.setCookie('trace_user_cookie', this.user);
        localStorage.setItem('trace_user_v2', JSON.stringify(this.user)); // New key to avoid conflicts
        console.log('User identity saved:', this.user);

        document.getElementById('identity-modal').classList.add('hidden');
        this.updateIdentityDisplay();
        this.trackPresence(); // IMMEDIATELY tell others you are online
    }

    loadIdentity() {
        try {
            const KEY = 'trace_user_v2';
            // 1. Try LocalStorage
            let saved = localStorage.getItem(KEY);
            if (saved && saved !== "undefined" && saved !== "null") {
                const user = JSON.parse(saved);
                if (user && user.id) {
                    console.info('Identity: Loaded from LocalStorage');
                    return user;
                }
            }

            // 2. Try Cookie fallback
            const cookieUser = this.getCookie('trace_user_cookie');
            if (cookieUser && cookieUser.id) {
                console.info('Identity: Loaded from Cookie');
                localStorage.setItem(KEY, JSON.stringify(cookieUser));
                return cookieUser;
            }

            console.info('Identity: No persistent user found.');
            return null;
        } catch (e) {
            console.warn('Identity: Corruption detected, resetting.', e);
            localStorage.removeItem('trace_user_v2');
            return null;
        }
    }

    updateIdentityDisplay() {
        const nickEls = [document.getElementById('current-user-nickname')];
        const avatarEls = [document.getElementById('current-user-avatar')];
        nickEls.forEach(el => el.innerText = this.user.nickname);
        avatarEls.forEach(el => this.renderAvatar(el, this.user.avatar));
    }

    renderAvatar(container, avatarUrl) {
        if (typeof avatarUrl !== 'string') {
            // Fallback for old data or missing avatars
            container.innerHTML = `<div style="width:100%;height:100%;background:#ccc;border-radius:50%"></div>`;
            return;
        }
        container.innerHTML = `<img src="${avatarUrl}" alt="avatar">`;
    }

    // --- Drawing ---

    resize() {
        // Set actual pixel dimensions to match our 3000px world
        this.canvas.width = 3000;
        this.canvas.height = 3000;
        this.render();
    }

    getCoord(e) {
        const rect = this.canvas.getBoundingClientRect();
        // Accounting for mobile zoom scale (0.5x)
        const scale = window.innerWidth < 768 ? 0.5 : 1.0;
        return {
            x: (e.clientX - rect.left) / scale,
            y: (e.clientY - rect.top) / scale
        };
    }

    startDrawing(e) {
        if (!this.user || this.isAuthenticated) return;
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
        const pos = this.getCoord(e);

        // Broadcast local cursor to others (via relay to avoid Pusher Auth overhead)
        if (this.user) {
            const now = Date.now();
            if (!this.lastBroadcast || now - this.lastBroadcast > 50) { // Throttle cursor
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
        if (!this.isDrawing) return;
        this.isDrawing = false;
        if (this.currentStroke) {
            // Instant broadcast via relay for live synchronization
            fetch('/api/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'new-stroke',
                    payload: this.currentStroke
                })
            }).catch(() => { });

            // Global persistence store (Cloudflare API)
            fetch('/api/traces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.currentStroke)
            }).catch(e => console.error('Cloud save failed:', e));
        }
    }

    undo() {
        if (this.localHistory.length === 0) return;
        const lastId = this.localHistory.pop();
        this.traces = this.traces.filter(t => t.id !== lastId);
        this.syncChannel.postMessage({ type: 'UNDO', payload: { id: lastId } });
        // No need to call saveTraces(), it's handled by the API
        this.render();
        this.updateStats();
    }

    // --- Rendering ---

    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const now = Date.now();
        this.traces = this.traces.filter(t => (now - t.timestamp) < this.fadeDuration);

        this.traces.forEach(stroke => {
            const elapsed = now - stroke.timestamp;
            const fadeAlpha = Math.max(0, 1 - (elapsed / this.fadeDuration));
            this.ctx.globalAlpha = fadeAlpha;
            this.drawFullStroke(stroke);
        });
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

    // --- Global Persistence (Cloudflare API) ---

    async loadWorld() {
        try {
            const res = await fetch('/api/traces');
            const data = await res.json();

            // Merge global traces (prefer local for real-time smoothness)
            const localIds = new Set(this.traces.map(t => t.id));
            const newGlobalTraces = data.traces.filter(t => !localIds.has(t.id));
            this.traces = [...this.traces, ...newGlobalTraces];

            this.analytics = data.analytics;

            if (this.isAuthenticated) this.showAdminPanel();
            this.render();
            this.updateStats();
            console.log('World loaded successfully.');
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
                    this.syncChannel.postMessage({ type: 'CLEAR_WORLD' });
                    console.log('World cleared successfully.');
                } else {
                    alert('clear failed.');
                    console.error('Clear failed with status:', res.status);
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

        // Extract unique contributors
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
        if (this.isAuthenticated) {
            this.showAdminPanel(); // Refresh full dashboard
        } else {
            const count = document.getElementById('trace-count');
            if (count) count.innerText = this.traces.length;
        }
    }

    loadTraces() { return null; } // Logic moved to loadWorld
}

window.onload = async () => {
    const app = new TraceApp();
    await app.trackVisit();
};
