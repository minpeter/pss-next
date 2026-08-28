import type { Server } from "node:http";
import { BoundaryInputError } from "./fault-proxy-types";

export function listenServer(
  server: Server,
  port: number,
  host: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export function tcpPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new BoundaryInputError("proxy has no TCP address");
  }
  return address.port;
}
