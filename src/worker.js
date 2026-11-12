import { DurableObject } from "cloudflare:workers";

export class GhostRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const existing = this.ctx.getWebSockets();
    const usedIds = new Set();
    for (const sock of existing) {
      const att = sock.deserializeAttachment();
      if (att && att.id) usedIds.add(att.id);
    }

    let id = 1 + Math.floor(Math.random() * 65000);
    while (usedIds.has(id)) id = 1 + Math.floor(Math.random() * 65000);

    // Golden-angle hue spacing so classmates get distinct bright neon colors
    const hue = Math.floor((existing.length * 137.508 + Math.random() * 50) % 360);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, hue });

    const total = existing.length + 1;
    server.send(JSON.stringify({ type: "welcome", id, hue, count: total }));
    this.broadcastJson({ type: "count", count: total }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment();
    if (!meta) return;

    // Relays compact 52-byte binary pose frames (13 Float32s) with 4-byte ID+Hue header
    if (message instanceof ArrayBuffer && message.byteLength === 52) {
      const out = new ArrayBuffer(56);
      const header = new DataView(out);
      header.setUint16(0, meta.id, true);
      header.setUint16(2, meta.hue, true);
      new Uint8Array(out, 4).set(new Uint8Array(message));

      for (const peer of this.ctx.getWebSockets()) {
        if (peer !== ws) {
          try {
            peer.send(out);
          } catch {}
        }
      }
    }
  }

  async webSocketClose(ws) {
    this.handleDisconnect(ws);
  }

  async webSocketError(ws) {
    this.handleDisconnect(ws);
  }

  handleDisconnect(ws) {
    const meta = ws.deserializeAttachment();
    const peers = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (meta) {
      this.broadcastJson({ type: "leave", id: meta.id, count: peers.length }, ws);
    }
  }

  broadcastJson(obj, excludeWs = null) {
    const raw = JSON.stringify(obj);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== excludeWs) {
        try {
          peer.send(raw);
        } catch {}
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      // Everyone joins "lab-main" by default, or use ?room=period2 to isolate classes
      const roomName = (url.searchParams.get("room") || "lab-main").slice(0, 32);
      const id = env.GHOST_ROOM.idFromName(roomName);
      const stub = env.GHOST_ROOM.get(id);
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
