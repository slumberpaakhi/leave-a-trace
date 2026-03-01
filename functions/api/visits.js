export async function onRequestPost(context) {
    const { env } = context;

    let analytics = await env.TRACES_KV.get("world_analytics", { type: "json" }) || { visits: 0, clears: 0 };
    analytics.visits++;

    await env.TRACES_KV.put("world_analytics", JSON.stringify(analytics));

    return new Response(JSON.stringify({ visits: analytics.visits }), {
        headers: { "Content-Type": "application/json" },
    });
}
