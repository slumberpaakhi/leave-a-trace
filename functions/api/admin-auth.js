export async function onRequestPost(context) {
    const { request, env } = context;
    const { password } = await request.json();

    // Use environment variable, fallback to 1234 for local development
    const adminPass = env.ADMIN_PASSWORD || "1234";

    if (password === adminPass) {
        return new Response(JSON.stringify({ success: true }));
    } else {
        return new Response(JSON.stringify({ error: 'incorrect passphrase.' }), { status: 401 });
    }
}
