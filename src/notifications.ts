interface Connection {
  url: string;
  token: string;
}

/** Notifications are hints; every ready/reconnect must trigger an HTTP catch-up. */
export class RemoteNotifications {
  private connection?: Connection;
  private socket?: WebSocket;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private failures = 0;

  constructor(
    private readonly changed: () => void,
    private readonly rejected: (status: 401 | 404) => void,
    private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url)
  ) {}

  configure(connection?: Connection): void {
    if (this.connection?.url === connection?.url && this.connection?.token === connection?.token) return;
    this.stop();
    this.connection = connection && { ...connection };
    if (this.connection) this.open();
  }

  reconnect(): void {
    this.disconnect();
    this.failures = 0;
    if (this.connection) this.open();
  }

  stop(): void {
    this.connection = undefined;
    this.failures = 0;
    this.disconnect();
  }

  private disconnect(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    this.retryTimer = this.watchdog = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(); } catch { /* A connecting socket may already be gone. */ }
    }
  }

  private open(): void {
    const connection = this.connection;
    if (!connection) return;
    let socket: WebSocket;
    try { socket = this.createSocket(connection.url); }
    catch { this.retry(); return; }
    this.socket = socket;
    let ready = false;
    const failed = (): void => {
      if (this.socket !== socket) return;
      this.disconnect();
      this.retry();
    };
    const watch = (ms: number): void => {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(failed, ms);
    };
    watch(10000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      try { socket.send(JSON.stringify({ type: "authenticate", token: connection.token })); }
      catch { failed(); }
    };
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      let message: { type?: string; sequence?: number };
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== "object") return;
      if (message.type === "ready") {
        ready = true;
        this.failures = 0;
        watch(45000);
        this.changed();
      } else if (ready && message.type === "ping") {
        watch(45000);
        try { socket.send(JSON.stringify({ type: "pong" })); } catch { failed(); }
      } else if (ready && (message.type === "resync" ||
        (message.type === "changed" && Number.isSafeInteger(message.sequence) && message.sequence! >= 0))) {
        watch(45000);
        this.changed();
      }
    };
    socket.onerror = failed;
    socket.onclose = event => {
      if (this.socket !== socket) return;
      if (event.code === 4401 || event.code === 4404) {
        this.stop();
        this.rejected(event.code === 4401 ? 401 : 404);
      } else { failed(); }
    };
  }

  private retry(): void {
    if (!this.connection || this.retryTimer !== undefined) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.open();
    }, delay);
  }
}
