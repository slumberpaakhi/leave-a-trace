export async function onRequestPost(context) {
    const { request, env } = context;
    const body = await request.json();

    // Pusher Credentials (Backend only)
    const APP_ID = "2121902";
    const KEY = "9916c0c7cc39de16616c";
    const SECRET = "6c0c972af8922c11a223";
    const CLUSTER = "ap2";

    const { event, payload } = body;

    // We use the Pusher REST API to broadcast the event
    // This allows the Cloudflare Worker to act as the 'Authenticated' sender
    const path = `/apps/${APP_ID}/events`;
    const timestamp = Math.floor(Date.now() / 1000);
    const bodyStr = JSON.stringify({
        name: event,
        channels: ["trace-world"],
        data: JSON.stringify(payload)
    });

    const bodyMd5 = await b64_md5(bodyStr);

    const params = `auth_key=${KEY}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
    const toSign = `POST\n${path}\n${params}`;

    const signature = await hmac_sha256(SECRET, toSign);
    const url = `https://api-${CLUSTER}.pusher.com${path}?${params}&auth_signature=${signature}`;

    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr
    });

    return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
    });
}

// Security helpers for Pusher Signature (Browser compatibility)
async function b64_md5(str) {
    const msgUint8 = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('MD5', msgUint8);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac_sha256(key, message) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(message);

    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}
