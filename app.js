import { getStroke } from 'https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.0/+esm';

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
        this.user = null;
        this.sessionSeed = Math.random().toString(36).substr(2, 9);

        // Data
        this.traces = [];
        this.localHistory = [];
        this.isPanMode = false;
        this.zoomScale = 1.0;
        this.minZoom = 0.2;
        this.maxZoom = 5.0;
        this.lastPinchDist = 0;

        // UI State
        this.panOffset = { x: 0, y: 0 };
        this.isPanning = false;
        this.lastPan = { x: 0, y: 0 };
        this.isAuthenticated = false;
        this.adminPass = '';
        this.analytics = { visits: 0, clears: 0 };

        // Real-time synchronization
        this.syncChannel = new BroadcastChannel('trace_global_sync');
        this.setupBroadcastSync();

        // Theme
        this.theme = localStorage.getItem('theme_v1') || 'light';
        document.body.setAttribute('data-theme', this.theme);

        // Admin State
        this.isAdmin = window.location.search.includes('admin=true') ||
            window.location.pathname.startsWith('/admin');

        this.init();
        console.log('TraceApp initialized.');
    }

    setupBroadcastSync() {
        this.syncChannel.onmessage = (e) => {
            const { type, payload } = e.data;
            if (type === 'NEW_TRACE') {
                if (!this.traces.some(t => t.id === payload.id)) {
                    this.traces.push(payload);
                    this.render();
                }
            } else if (type === 'UNDO') {
                this.traces = this.traces.filter(t => t.id !== payload.id);
                this.render();
            } else if (type === 'CLEAR_WORLD') {
                this.traces = [];
                this.render();
            }
        };
    }

    setupRealtime() {
        if (typeof Pusher === 'undefined' || !this.user) return;
        if (this.pusher) return; // Prevent double setup

        this.pusher = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER });
        this.channel = this.pusher.subscribe('trace-world');
        this.remoteCursors = new Map();
        this.presenceContainer = document.getElementById('remote-cursors-layer');

        this.channel.bind('undo-stroke', (data) => {
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
            this.traces = [];
            this.localHistory = [];
            this.render();
            this.updateStats();
        });
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
        cursor.style.transform = `translate(${(data.pos.x - this.panOffset.x) * this.zoomScale}px, ${(data.pos.y - this.panOffset.y) * this.zoomScale}px)`;
    }

    init() {
        // Essential listeners first
        const saveBtn = document.getElementById('save-identity');
        if (saveBtn) saveBtn.onclick = () => this.saveIdentity();

        const nickInput = document.getElementById('nickname-input');
        const userPassInput = document.getElementById('user-password-input');
        [nickInput, userPassInput].forEach(inp => {
            if (inp) inp.onkeypress = (e) => { if (e.key === 'Enter') this.saveIdentity(); };
        });
        if (nickInput) nickInput.oninput = (e) => this.updateSetupPreview(e.target.value);

        this.resize();
        this.centerView();
        window.addEventListener('resize', () => this.resize());

        // Identity Flow
        const modal = document.getElementById('identity-modal');
        const savedUser = this.loadIdentity();

        if (this.isAdmin) {
            if (modal) modal.classList.add('hidden');
        } else if (savedUser) {
            this.user = savedUser;
            if (modal) modal.classList.add('hidden');
            this.updateIdentityDisplay();
            this.setupRealtime();
        } else {
            if (modal) modal.classList.remove('hidden');
        }

        // Admin Flow
        if (this.isAdmin) {
            const adminModal = document.getElementById('admin-modal');
            if (adminModal) adminModal.classList.remove('hidden');
            const loginBtn = document.getElementById('admin-login-btn');
            if (loginBtn) {
                loginBtn.onclick = async () => {
                    const pass = document.getElementById('admin-password-input').value;
                    try {
                        const res = await fetch('/api/admin-auth', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: pass })
                        });
                        if (res.ok) {
                            this.isAuthenticated = true;
                            this.adminPass = pass;
                            if (adminModal) adminModal.classList.add('hidden');
                            document.body.classList.add('is-admin');
                            this.showAdminPanel();
                        } else {
                            throw new Error('Auth failed');
                        }
                    } catch (e) {
                        const error = document.getElementById('admin-login-error');
                        if (error) {
                            error.innerText = 'incorrect passphrase.';
                            error.style.opacity = '1';
                            setTimeout(() => error.style.opacity = '0', 3000);
                        }
                    }
                };
            }
        }

        // Interaction Listeners
        this.canvas.addEventListener('mousedown', (e) => this.startDrawing(e));
        window.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        window.addEventListener('mouseup', () => this.stopDrawing());

        this.canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                this.lastPinchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            } else {
                const touch = e.touches[0];
                this.startDrawing({ clientX: touch.clientX, clientY: touch.clientY });
            }
        });
        this.canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 2) {
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                this.handleZoom(dist / this.lastPinchDist, midX, midY);
                this.lastPinchDist = dist;
            } else {
                const touch = e.touches[0];
                this.handleMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
            }
        }, { passive: false });
        this.canvas.addEventListener('touchend', () => {
            this.stopDrawing();
            this.lastPinchDist = 0;
        });

        window.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? 0.9 : 1.1;
                this.handleZoom(delta, e.clientX, e.clientY);
            }
        }, { passive: false });

        document.getElementById('undo-btn').onclick = () => this.undo();
        document.getElementById('pan-btn').onclick = () => {
            this.isPanMode = !this.isPanMode;
            document.getElementById('pan-btn').classList.toggle('active', this.isPanMode);
            this.setCursor(this.isPanMode ? 'pan' : this.currentColor);
        };
        document.getElementById('center-btn').onclick = () => this.centerView();
        document.getElementById('reset-btn').onclick = () => this.clearAll();
        document.getElementById('theme-toggle').onclick = () => this.toggleTheme();

        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.onclick = (e) => {
                this.currentColor = e.target.dataset.color;
                this.isPanMode = false;
                document.getElementById('pan-btn').classList.remove('active');
                this.setCursor(this.currentColor);
                document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            };
        });

        const sizeSlider = document.getElementById('size-slider');
        if (sizeSlider) {
            sizeSlider.oninput = (e) => {
                this.currentSize = parseInt(e.target.value);
                const hint = document.getElementById('current-size-hint');
                if (hint) hint.innerText = this.currentSize;
            };
        }

        this.loadWorld();
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
            localStorage.setItem('trace_user_v2', JSON.stringify(this.user));
            document.getElementById('identity-modal').classList.add('hidden');
            this.updateIdentityDisplay();
            this.setupRealtime();
        } catch (e) {
            alert('auth error');
        }
    }

    loadIdentity() {
        try {
            const saved = localStorage.getItem('trace_user_v2');
            if (saved && saved !== "undefined") return JSON.parse(saved);
        } catch (e) { }
        return null;
    }

    updateIdentityDisplay() {
        if (!this.user) return;
        const nickEl = document.getElementById('current-user-nickname');
        const avatarEl = document.getElementById('current-user-avatar');
        if (nickEl) nickEl.innerText = this.user.nickname;
        if (avatarEl) this.renderAvatar(avatarEl, this.user.avatar);
    }

    renderAvatar(container, url) {
        if (!container) return;
        container.innerHTML = `<img src="${url}" style="width:100%; height:100%; display:block;">`;
    }

    getAvatarUrl(seed) {
        return `https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(seed)}`;
    }

    updateSetupPreview(nick) {
        const seed = nick.trim() + (this.sessionSeed || 'init');
        const previewEl = document.getElementById('setup-avatar-preview');
        if (previewEl) this.renderAvatar(previewEl, this.getAvatarUrl(seed));
    }

    toggleTheme() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        document.body.setAttribute('data-theme', this.theme);
        localStorage.setItem('theme_v1', this.theme);
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.render();
    }

    centerView() {
        this.zoomScale = 1.0;
        this.panOffset = { x: -window.innerWidth / 2, y: -window.innerHeight / 2 };
        this.render();
    }

    handleZoom(factor, centerX, centerY) {
        const oldScale = this.zoomScale;
        const newScale = Math.min(this.maxZoom, Math.max(this.minZoom, oldScale * factor));
        if (newScale === oldScale) return;

        const worldX = (centerX / oldScale) + this.panOffset.x;
        const worldY = (centerY / oldScale) + this.panOffset.y;

        this.zoomScale = newScale;
        this.panOffset.x = worldX - (centerX / newScale);
        this.panOffset.y = worldY - (centerY / newScale);
        this.render();
    }

    getCoord(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / this.zoomScale + this.panOffset.x,
            y: (e.clientY - rect.top) / this.zoomScale + this.panOffset.y
        };
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
            points: [[pos.x, pos.y, 0.5]]
        };
        this.traces.push(this.currentStroke);
        this.localHistory.push(this.currentStroke.id);
        this.updateStats();
        this.syncChannel.postMessage({ type: 'NEW_TRACE', payload: this.currentStroke });
    }

    handleMouseMove(e) {
        if (this.isPanning) {
            const dx = (e.clientX - this.lastPan.x) / this.zoomScale;
            const dy = (e.clientY - this.lastPan.y) / this.zoomScale;
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
                            id: this.user.id, nickname: this.user.nickname,
                            avatar: this.user.avatar, color: this.currentColor, pos: pos
                        }
                    })
                }).catch(() => { });
            }
        }

        if (this.isDrawing) {
            const last = this.currentStroke.points[this.currentStroke.points.length - 1];
            if (Math.hypot(pos.x - last[0], pos.y - last[1]) > 3) {
                this.currentStroke.points.push([pos.x, pos.y, 0.5]);
                this.render();
            }
        } else if (window.matchMedia('(hover: hover)').matches) {
            this.checkHover(e);
        }
    }

    stopDrawing() {
        if (this.isPanning) {
            this.isPanning = false;
            document.body.style.cursor = this.isPanMode ? 'grab' : 'crosshair';
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
            }).catch(() => { });
        }
    }

    async undo() {
        if (this.localHistory.length === 0) return;
        const lastId = this.localHistory.pop();
        this.traces = this.traces.filter(t => t.id !== lastId);
        this.syncChannel.postMessage({ type: 'UNDO', payload: { id: lastId } });
        fetch('/api/sync', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'undo-stroke', payload: { id: lastId } })
        }).catch(() => { });
        fetch('/api/traces', {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: lastId })
        }).catch(() => { });
        this.render();
        this.updateStats();
    }

    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const now = Date.now();
        this.traces = this.traces.filter(t => (now - t.timestamp) < this.fadeDuration);

        const bgX = -this.panOffset.x * this.zoomScale;
        const bgY = -this.panOffset.y * this.zoomScale;
        const bgSize = 1000 * this.zoomScale;
        document.body.style.backgroundPosition = `${bgX}px ${bgY}px`;
        document.body.style.backgroundSize = `${bgSize}px`;

        this.ctx.save();
        this.ctx.scale(this.zoomScale, this.zoomScale);
        this.ctx.translate(-this.panOffset.x, -this.panOffset.y);
        this.traces.forEach(stroke => {
            const alpha = Math.max(0, 1 - ((now - stroke.timestamp) / this.fadeDuration));
            this.drawFullStroke(stroke, alpha);
        });
        this.ctx.restore();
    }

    drawFullStroke(stroke, alpha = 1) {
        if (!stroke.points || stroke.points.length < 1) return;
        const normalized = stroke.points.map(p => Array.isArray(p) ? p : [p.x, p.y, 0.5]);
        try {
            const outline = getStroke(normalized, {
                size: stroke.size, thinning: 0.5, smoothing: 0.5, simulatePressure: true, last: true
            });
            if (outline.length === 0) return;
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.fillStyle = stroke.color;
            this.ctx.globalAlpha = alpha;
            const path = new Path2D(this.getSvgPathFromStroke(outline));
            this.ctx.fill(path);
            this.ctx.restore();
        } catch (e) { }
    }

    getSvgPathFromStroke(stroke) {
        if (!stroke.length) return "";
        const d = stroke.reduce((acc, [x0, y0], i, arr) => {
            if (i === 0) acc.push("M", x0, y0, "Q");
            else { const [x1, y1] = arr[i - 1]; acc.push((x0 + x1) / 2, (y0 + y1) / 2, x0, y0); }
            return acc;
        }, ["M", stroke[0][0], stroke[0][1], "Q"]);
        d.push("Z");
        return d.join(" ");
    }

    checkHover(e) {
        const tooltip = document.getElementById('trace-tooltip');
        let found = null;
        const pos = this.getCoord(e);
        for (let i = this.traces.length - 1; i >= 0; i--) {
            const stroke = this.traces[i];
            for (let j = 0; j < stroke.points.length; j += 10) {
                const p = stroke.points[j];
                const px = Array.isArray(p) ? p[0] : p.x;
                const py = Array.isArray(p) ? p[1] : p.y;
                if (Math.hypot(pos.x - px, pos.y - py) < 15) { found = stroke; break; }
            }
            if (found) break;
        }
        if (found) {
            tooltip.classList.remove('hidden');
            tooltip.style.left = (e.clientX + 15) + 'px';
            tooltip.style.top = (e.clientY + 15) + 'px';
            document.getElementById('tooltip-nickname').innerText = found.nickname;
            this.renderAvatar(document.getElementById('tooltip-avatar'), found.avatar);
        } else { tooltip.classList.add('hidden'); }
    }

    async loadWorld() {
        try {
            const res = await fetch('/api/traces');
            const data = await res.json();
            this.traces = data.traces || [];
            this.analytics = data.analytics || { visits: 0, clears: 0 };
            this.render();
            this.updateStats();
        } catch (e) { }
    }

    async trackVisit() { fetch('/api/visits', { method: 'POST' }).catch(() => { }); }

    async clearAll() {
        if (!this.isAuthenticated) return;
        if (!confirm('clear world?')) return;
        await fetch('/api/traces', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: this.adminPass }) });
        this.traces = [];
        this.render();
    }

    setCursor(type) {
        if (type === 'pan') { document.body.style.cursor = 'grab'; return; }
        document.body.style.cursor = 'crosshair';
    }

    updateStats() {
        const count = document.getElementById('trace-count');
        if (count) count.innerText = this.traces.length;
    }
}

window.onload = () => { new TraceApp(); };
