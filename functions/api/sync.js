export async function onRequestPost(context) {
    const { request } = context;
    const body = await request.json();

    const APP_ID = "2121902";
    const KEY = "9916c0c7cc39de16616c";
    const SECRET = "6c0c972af8922c11a223";
    const CLUSTER = "ap2";

    const { event, payload } = body;
    const path = `/apps/${APP_ID}/events`;
    const timestamp = Math.floor(Date.now() / 1000);
    const bodyStr = JSON.stringify({
        name: event,
        channels: ["trace-world"],
        data: JSON.stringify(payload)
    });

    // Simple MD5 for Cloudflare Workers (Hex output)
    const bodyMd5 = Array.from(new Uint8Array(await crypto.subtle.digest('MD5', new TextEncoder().encode(bodyStr))))
        .map(b => b.toString(16).padStart(2, '0')).join('');

    const params = `auth_key=${KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const toSign = `POST\n${path}\n${params}`;

    const signature = await hmac_sha256(SECRET, toSign);
    const url = `https://api-${CLUSTER}.pusher.com${path}?${params}&auth_signature=${signature}`;

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyStr
        });
        return new Response(JSON.stringify({ success: true }));
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

async function hmac_sha256(key, message) {
    const keyUint8 = new TextEncoder().encode(key);
    const msgUint8 = new TextEncoder().encode(message);
    const cryptoKey = await crypto.subtle.importKey('raw', keyUint8, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgUint8);
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
