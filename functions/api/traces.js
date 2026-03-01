export async function onRequestGet(context) {
    const { env } = context;
    const traces = await env.TRACES_KV.get("world_traces", { type: "json" }) || [];
    const analytics = await env.TRACES_KV.get("world_analytics", { type: "json" }) || { visits: 0, clears: 0 };

    return new Response(JSON.stringify({ traces, analytics }), {
        headers: { "Content-Type": "application/json" },
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;
    const newTrace = await request.json();

    // Load current world
    let traces = await env.TRACES_KV.get("world_traces", { type: "json" }) || [];

    // Add new trace and keep latest 1000 to prevent overflow
    traces.push(newTrace);
    if (traces.length > 1000) traces.shift();

    await env.TRACES_KV.put("world_traces", JSON.stringify(traces));

    return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
    });
}

export async function onRequestDelete(context) {
    const { request, env } = context;
    const { password, id } = await request.json();

    // 1. Global Clear (requires password)
    if (password) {
        if (password !== "1234") {
            return new Response("Unauthorized", { status: 401 });
        }
        await env.TRACES_KV.put("world_traces", JSON.stringify([]));
        let analytics = await env.TRACES_KV.get("world_analytics", { type: "json" }) || { visits: 0, clears: 0 };
        analytics.clears++;
        await env.TRACES_KV.put("world_analytics", JSON.stringify(analytics));

        return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    // 2. Individual Undo (requires trace ID)
    if (id) {
        let traces = await env.TRACES_KV.get("world_traces", { type: "json" }) || [];
        const filtered = traces.filter(t => t.id !== id);
        await env.TRACES_KV.put("world_traces", JSON.stringify(filtered));

        return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" },
        });
    }

    return new Response("Bad Request", { status: 400 });
}
