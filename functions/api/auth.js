export async function onRequestPost(context) {
    const { request, env } = context;
    const { nickname, password } = await request.json();

    if (!nickname || !password || password.length < 4) {
        return new Response(JSON.stringify({ error: 'invalid credentials' }), { status: 400 });
    }

    const key = `user_auth:${nickname.toLowerCase()}`;
    const existing = await env.TRACES_KV.get(key, { type: 'json' });

    if (existing) {
        if (existing.password === password) {
            return new Response(JSON.stringify({ success: true, user: existing }));
        } else {
            return new Response(JSON.stringify({ error: 'incorrect password for this nickname' }), { status: 401 });
        }
    } else {
        // Create new user
        const newUser = {
            id: Math.random().toString(36).substr(2, 9),
            nickname: nickname,
            password: password,
            created: Date.now()
        };
        await env.TRACES_KV.put(key, JSON.stringify(newUser));
        return new Response(JSON.stringify({ success: true, user: newUser }));
    }
}
